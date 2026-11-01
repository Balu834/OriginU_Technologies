/**
 * POST /qr/events — what the QR gateway tells us. UNOFFICIAL route: see
 * lib/qrGateway.mjs.
 *
 * Signed by the gateway (lib/qrSigning.mjs); anything unsigned is refused
 * before the body is read. Four event types:
 *
 *   connection  { state: "connected", phone } or logged_out / banned / failed / replaced
 *   message     { from, text, messageId, messageType, timestamp }
 *   owner_reply { to }   the owner typed to this person from their phone
 *   receipt     { messageId, status }
 *
 * The answer `{ stop: true }` tells the gateway to log the session out:
 * the business doesn't exist, isn't on the QR route any more, or nobody
 * asked for this link. A session we didn't ask for is not one we use.
 *
 * Privacy: the gateway forwards every personal-chat text, because only
 * this side knows who missed-called. Anything not from a caller is dropped
 * here: not stored, not logged, not answered.
 */
import { verifyQrRequest, QR_SIGNATURE_HEADER } from "../lib/qrSigning.mjs";
import { QR_PROVIDER, qrShouldReply, QR_FAILURE_MESSAGES } from "../lib/qrGateway.mjs";
import { PHONE_NUMBER_CLAIMED } from "../lib/integrations.mjs";
import { clientForBusiness, ownerAlertClientForBusiness, refusingClient } from "../lib/outbound.mjs";
import { processInboundMessage, tenantConfigFor } from "../lib/inbound.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { createMailer } from "../lib/mailer.mjs";
import { toE164 } from "../lib/phone.mjs";
import { log, logError } from "../lib/logger.mjs";

/** Set when the owner presses Start; a link nobody asked for is refused. */
export const qrPendingKey = (businessId) => `qrpending:${businessId}`;
/** Set when a link failed for a reason the settings page must show. */
export const qrErrorKey = (businessId) => `qrerror:${businessId}`;
export const QR_PENDING_TTL_SECONDS = 15 * 60;

const FAILURE_REASONS = {
  logged_out: "whatsapp_logged_out",
  banned: "whatsapp_number_blocked",
  failed: "whatsapp_disconnected",
  replaced: "whatsapp_session_replaced",
};

const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const stop = (reason) => {
  log("qr_event_stop", { reason });
  return { status: 200, body: { ok: true, stop: true, reason } };
};

export async function handleQrEvent(ctx, deps) {
  const secret = deps.config?.QR_GATEWAY_SECRET;
  if (!secret) return { status: 404, body: { error: "not found" } };
  if (!verifyQrRequest(ctx.rawBody, ctx.headers?.[QR_SIGNATURE_HEADER], secret)) {
    logError("qr_event_invalid_signature", new Error("signature mismatch"), {});
    return { status: 403, body: { error: "invalid signature" } };
  }

  let event;
  try {
    event = JSON.parse(ctx.rawBody?.toString("utf8") || "{}");
  } catch {
    return { status: 400, body: { error: "malformed JSON" } };
  }

  const businessId = String(event.businessId ?? "");
  const business = businessId ? deps.businesses?.byId(businessId) ?? null : null;
  if (!business) return stop("unknown_business");

  const integration = await deps.integrations.forBusiness(businessId);
  const isQr = integration?.provider === QR_PROVIDER;

  switch (event.type) {
    case "connection":
      return onConnection(event, { business, integration, isQr, deps });
    case "message":
      return onMessage(event, { business, integration, isQr, deps });
    case "owner_reply":
      return onOwnerReply(event, { business, isQr, deps });
    case "receipt":
      return onReceipt(event, { business, isQr, deps });
    default:
      return { status: 400, body: { error: "unknown event type" } };
  }
}

async function onConnection(event, { business, integration, isQr, deps }) {
  const { store, integrations } = deps;
  const businessId = business.id;

  if (event.state === "connected") {
    const pending = await store.getFlag?.(qrPendingKey(businessId));
    const phone = toE164(event.phone);
    if (!phone) return stop("no_phone");
    const digits = phone.replace(/\D/g, "");

    // A link the owner asked for (pending), or the gateway reopening one
    // that is already ours after a restart. Anything else is refused.
    const sameNumber = isQr && integration.phoneNumberId === `qr:${digits}`;
    if (!pending) {
      if (!isQr || integration.status === "NOT_CONNECTED") return stop("not_requested");
      if (!sameNumber) return stop("different_number");
      if (integration.status === "CONNECTED") return ok();
    }

    try {
      await integrations.registerQr({ businessId, phone, acknowledgement: pending?.acknowledgement ?? null });
    } catch (err) {
      if (err.code === PHONE_NUMBER_CLAIMED) {
        await store.saveFlag?.(qrErrorKey(businessId), "claimed", QR_PENDING_TTL_SECONDS);
        await store.deleteFlag?.(qrPendingKey(businessId));
        return stop("number_claimed");
      }
      throw err;
    }
    await store.deleteFlag?.(qrPendingKey(businessId));
    await store.deleteFlag?.(qrErrorKey(businessId));
    log("qr_connected", { businessId });
    return ok();
  }

  const reason = FAILURE_REASONS[event.state];
  if (!reason) return { status: 400, body: { error: "unknown connection state" } };
  if (!isQr || integration.status === "NOT_CONNECTED") return ok();

  await integrations.markVerificationFailed(integration, reason);
  log("qr_connection_lost", { businessId, state: event.state });
  if (event.state === "logged_out" || event.state === "banned") {
    await emailOwners(business, QR_FAILURE_MESSAGES[reason], deps);
  }
  return ok();
}

async function onMessage(event, { business, integration, isQr, deps }) {
  if (!isQr || integration.status === "NOT_CONNECTED") return stop("not_qr");
  if (integration.status !== "CONNECTED") return ok({ ignored: "not_connected" });

  const from = toE164(event.from);
  if (!from) return ok({ ignored: "no_sender" });

  const tenantStore = scopedToBusiness(deps.store, business.id);
  const conversation = await tenantStore.getConversation(from);
  const lastMissedCallAt = await tenantStore.lastMissedCallAt(from);
  if (!qrShouldReply(conversation, lastMissedCallAt)) {
    // Not a caller (or the owner has taken over): no number in the log.
    log("qr_message_not_for_bot", { businessId: business.id });
    return ok({ ignored: "not_a_caller" });
  }

  const tenantWa = (await clientForBusiness(business.id, deps)) ?? refusingClient(business.id, log);
  const alertWa = (await ownerAlertClientForBusiness(business.id, deps)) ?? refusingClient(business.id, log);

  await processInboundMessage(
    {
      id: event.messageId ? `qr:${event.messageId}` : null,
      type: event.messageType === "text" ? "text" : String(event.messageType ?? "other"),
      from,
      text: String(event.text ?? ""),
      timestamp: event.timestamp ?? null,
    },
    { business, tenantStore, tenantWa, alertWa, tenantConfig: tenantConfigFor(deps.config, business), deps }
  );
  return ok();
}

async function onOwnerReply(event, { business, isQr, deps }) {
  if (!isQr) return ok();
  const to = toE164(event.to);
  if (!to) return ok();
  const tenantStore = scopedToBusiness(deps.store, business.id);
  const conversation = await tenantStore.getConversation(to);
  if (!conversation) return ok();
  await tenantStore.saveConversation(to, { ...conversation, ownerTookOverAt: new Date().toISOString() });
  log("qr_owner_took_over", { businessId: business.id });
  return ok();
}

async function onReceipt(event, { business, isQr, deps }) {
  if (!isQr || !event.messageId) return ok();
  const tenantStore = scopedToBusiness(deps.store, business.id);
  const stored = await tenantStore.findMessageByProviderId?.(String(event.messageId));
  if (!stored) return ok();
  const status = ["sent", "delivered", "read", "failed"].includes(event.status) ? event.status : null;
  if (!status) return ok();
  await tenantStore.updateMessage({
    ...stored,
    deliveryStatus: status,
    metadata: { ...stored.metadata, statusAt: new Date().toISOString() },
  });
  return ok();
}

/** Best-effort email to the business's owners and admins. Never throws. */
async function emailOwners(business, sentence, deps) {
  try {
    const mailer = deps.mailer ?? createMailer(deps.config ?? {});
    if (!mailer.configured || !deps.accounts?.membersOf) return;
    const members = await deps.accounts.membersOf(business.id);
    for (const m of members) {
      if (m.role !== "OWNER" && m.role !== "ADMIN") continue;
      const user = await deps.store.getUser?.(m.userId);
      if (!user?.email) continue;
      await mailer.send({
        to: user.email,
        subject: `MissedCall: WhatsApp disconnected for ${business.name || "your business"}`,
        text: `${sentence}\n\nMissed-call replies are paused until this is fixed. Open ${String(deps.config?.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}/settings/whatsapp to reconnect.\n\nMissedCall`,
      });
    }
  } catch (err) {
    logError("qr_owner_email_failed", err, { businessId: business.id });
  }
}
