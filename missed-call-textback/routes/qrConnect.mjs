/**
 * The settings-page side of the UNOFFICIAL QR-code connection.
 *
 *   POST /settings/whatsapp/qr/start   start (or reconnect) a link: QR or pairing code
 *   GET  /settings/whatsapp/qr/status  live state for the page to poll (JSON)
 *   POST /settings/whatsapp/qr/logout  unlink the device and forget the session
 *
 * Same session -> membership -> role checks as every other settings route.
 * Starting needs the owner to have ticked the risk warning; who ticked it
 * and when is kept on the connection. The business always comes from the
 * membership, never the form.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor, can } from "../lib/users.mjs";
import { QR_PROVIDER, qrConnectConfig, QR_STATE_MESSAGES } from "../lib/qrGateway.mjs";
import { qrPendingKey, qrErrorKey, QR_PENDING_TTL_SECONDS } from "./qrEvents.mjs";
import { toE164 } from "../lib/phone.mjs";
import { log } from "../lib/logger.mjs";

const redirect = (to) => ({ status: 302, headers: { Location: to }, body: {} });
const SIGN_IN = "/leads";
const back = (marker) => redirect(`/settings/whatsapp?q=${marker}#qr`);

async function actorFor(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  return resolveActor(session, deps.accounts);
}

function formOf(ctx) {
  return new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
}

export async function handleQrStart(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor?.businessId) return redirect(SIGN_IN);
  if (!can(actor.role, "manageSettings")) {
    log("settings_change_denied", { role: actor.role });
    return redirect("/settings/whatsapp");
  }

  const integration = await deps.integrations.forBusiness(actor.businessId);
  const alreadyQr = integration?.provider === QR_PROVIDER;

  // A brand-new link is only offered while the flag is on. Reconnecting a
  // business already on QR keeps working with the flag off.
  const qr = qrConnectConfig(deps.config ?? {});
  if (!deps.qrGateway || (!qr.available && !alreadyQr)) return back("off");

  // A business already on the official route keeps it. Switching to the
  // unofficial one is a step down that should never happen by a stray form.
  if (integration && !alreadyQr && integration.status === "CONNECTED") return back("official");

  const form = formOf(ctx);
  const acknowledged = form.get("ack") === "yes";
  if (!acknowledged && !(alreadyQr && integration.qrAcknowledgement)) return back("ack");

  const mode = form.get("mode") === "code" ? "code" : "qr";
  let phone = "";
  if (mode === "code") {
    phone = toE164(form.get("phone") ?? "") ?? "";
    if (!phone) return back("phone");
  }

  const at = new Date().toISOString();
  await deps.store.saveFlag(qrPendingKey(actor.businessId), {
    at,
    mode,
    acknowledgement: acknowledged ? { userId: actor.user?.id ?? null, role: actor.role, at } : null,
  }, QR_PENDING_TTL_SECONDS);
  await deps.store.deleteFlag(qrErrorKey(actor.businessId));

  const started = await deps.qrGateway.start(actor.businessId, { mode, phone });
  log("qr_start_requested", { businessId: actor.businessId, mode, ok: started.ok, code: started.body?.code ?? null });
  if (!started.ok) return back(started.body?.code === "bad_phone" ? "phone" : "down");
  return back("started");
}

export async function handleQrStatus(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor?.businessId) return { status: 401, body: { error: "sign in" } };

  const integration = await deps.integrations.forBusiness(actor.businessId);
  const connected = integration?.provider === QR_PROVIDER && integration.status === "CONNECTED";
  if (connected) return { status: 200, body: { state: "connected", connected: true, message: "Connected." } };

  const error = await deps.store.getFlag(qrErrorKey(actor.businessId));
  if (error === "claimed") {
    return { status: 200, body: { state: "claimed", connected: false, message: QR_STATE_MESSAGES.claimed } };
  }
  if (!deps.qrGateway) return { status: 200, body: { state: "unreachable", connected: false, message: QR_STATE_MESSAGES.unreachable } };

  const reply = await deps.qrGateway.status(actor.businessId);
  const status = reply.ok ? reply.body?.status ?? {} : { state: "unreachable" };
  const state = Object.hasOwn(QR_STATE_MESSAGES, status.state) ? status.state : "unreachable";

  // Only what the page draws. The QR is a PNG data URL produced by the
  // gateway; the page puts it in an <img>, never in the markup.
  const qrDataUrl = typeof status.qrDataUrl === "string" && status.qrDataUrl.startsWith("data:image/png;base64,")
    ? status.qrDataUrl
    : null;
  const pairingCode = typeof status.pairingCode === "string" && /^[A-Z0-9-]{4,12}$/i.test(status.pairingCode)
    ? status.pairingCode
    : null;

  return {
    status: 200,
    body: { state, connected: false, message: QR_STATE_MESSAGES[state], qrDataUrl, pairingCode },
  };
}

export async function handleQrLogout(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor?.businessId) return redirect(SIGN_IN);
  if (!can(actor.role, "manageSettings")) {
    log("settings_change_denied", { role: actor.role });
    return redirect("/settings/whatsapp");
  }

  const integration = await deps.integrations.forBusiness(actor.businessId);
  // Asked even when the record says something else: a half-finished link
  // can leave a session on the gateway with no record here.
  const result = deps.qrGateway ? await deps.qrGateway.logout(actor.businessId) : { ok: false };
  if (integration?.provider === QR_PROVIDER) {
    await deps.integrations.markDisconnected(integration, "logged_out_by_owner");
  }
  await deps.store.deleteFlag(qrPendingKey(actor.businessId));
  log("qr_logout_requested", { businessId: actor.businessId, gatewayOk: Boolean(result.ok) });
  return back("loggedout");
}
