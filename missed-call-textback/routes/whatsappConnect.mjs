/**
 * Finishing an Embedded Signup, and re-testing a finished one.
 *
 *   POST /settings/whatsapp/connect   the browser hands back what Meta gave it
 *   POST /settings/whatsapp/test      ask Meta again whether it still works
 *   POST /settings/whatsapp/templates create any of our message templates the WABA lacks
 *   POST /settings/whatsapp/send-test send the missed-call message to a number the owner types
 *
 * Both reuse the existing machinery rather than adding a second way to do
 * anything: the same session -> membership -> role authorization as every
 * other settings route, the same `integrations.register()` (so the same
 * uniqueness rule and the same encryption), and the same `metaVerifier` —
 * which remains the ONLY thing in this codebase that can make a connection
 * CONNECTED. A completed Meta popup is not evidence; Meta answering a
 * question about the stored credentials is.
 *
 * The browser supplies `code`, `phone_number_id` and `waba_id`. None of
 * them is trusted as authority:
 *
 *   - the business comes from the membership, never from the body;
 *   - the code is worthless without our app secret, which stays here;
 *   - the number/WABA pair is proven by verification, which asks Meta
 *     whether THIS token reaches THAT number and whether THAT WABA owns
 *     it, so a forged pair fails unless the caller genuinely owns it;
 *   - and `register()` still refuses a number another business holds.
 *
 * Nothing in either response contains a credential. The connect route
 * answers JSON with a redirect target and a sentence; the test route
 * answers a redirect carrying a status marker.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor, can } from "../lib/users.mjs";
import { embeddedSignupConfig, SIGNUP_FAILURES, signupMessage, TEMPLATE_DEFINITIONS } from "../lib/embeddedSignup.mjs";
import { expiryFromSeconds } from "../lib/integrations.mjs";
import { reportMissedCall } from "./missedCall.mjs";
import { log, logError } from "../lib/logger.mjs";
import { OWNER_ALERT_TEMPLATE } from "../lib/ownerAlert.mjs";

const redirect = (to) => ({ status: 302, headers: { Location: to }, body: {} });

/** Signed out: `/leads` renders the sign-in form. `GET /login` does not exist. */
const SIGN_IN = "/leads";

/** A failure the browser can show verbatim — sentence only, never a Meta error. */
const refuse = (status, reason) => ({
  status,
  body: { ok: false, reason, error: signupMessage(reason), redirect: `/settings/whatsapp?e=${reason}` },
});

/** Reads the JSON body in whichever shape the environment provides it. */
function readBody(ctx) {
  if (ctx.json && typeof ctx.json === "object") return ctx.json;
  const raw = ctx.rawBody?.toString("utf8") ?? "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

/** The acting user, or null. Same path as every other authenticated route. */
async function actorFor(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  return resolveActor(session, deps.accounts);
}

export async function handleWhatsappConnect(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor?.businessId) return { status: 401, body: { ok: false, error: "Sign in to connect WhatsApp." } };

  if (!can(actor.role, "manageSettings")) {
    log("settings_change_denied", { role: actor.role });
    return { status: 403, body: { ok: false, error: "Your role cannot change integration settings." } };
  }

  const signup = embeddedSignupConfig(deps.config ?? {});
  if (!signup.available || !deps.embeddedSignup) {
    return refuse(503, SIGNUP_FAILURES.NOT_CONFIGURED);
  }

  const body = readBody(ctx);
  const code = String(body.code ?? "").trim();
  let phoneNumberId = String(body.phoneNumberId ?? body.phone_number_id ?? "").trim();
  let wabaId = String(body.wabaId ?? body.waba_id ?? "").trim();

  // Logged before refusing: an abandoned or half-delivered Meta flow is
  // otherwise invisible, because the browser is the only place it shows.
  // Only when there is no code: with a code the request goes on to Meta,
  // and the line that matters is Meta's answer — Vercel's log view shows
  // just the first line a request writes.
  if (!code) {
    log("embedded_signup_incomplete", {
      businessId: actor.businessId,
      hasCode: Boolean(code),
      hasPhoneNumberId: Boolean(phoneNumberId),
      hasWabaId: Boolean(wabaId),
      // Shape only, sanitised again here: never trust the browser to have
      // kept ids or codes out of it.
      metaMessages: Array.isArray(body.seen)
        ? body.seen.slice(0, 12).map((m) => ({
            origin: String(m?.origin ?? "").replace(/[^a-z0-9.:/-]/gi, "").slice(0, 60),
            type: String(m?.type ?? "").replace(/[^A-Z0-9_ a-z-]/g, "").slice(0, 40),
            event: String(m?.event ?? "").replace(/[^A-Z0-9_ a-z-]/g, "").slice(0, 40),
          }))
        : [],
    });
  }
  if (!code) return refuse(400, SIGNUP_FAILURES.MISSING_CODE);

  // The page that opened Meta's dialog, as candidates for the redirect_uri
  // Meta bound the code to. Only this deployment's own /settings/whatsapp
  // address is ever forwarded — a URL from the request body is otherwise
  // attacker-chosen text sent to Meta alongside our app secret.
  const base = String(deps.config?.WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");
  const pageUrl = String(body.pageUrl ?? "");
  const redirectUris = [];
  // The redirect_uri Meta's own dialog was opened with, as read by the page.
  // Accepted only when it is one of Meta's relay addresses: it is sent to
  // Meta next to our app secret, so nothing else may ride in this field.
  const dialogRedirect = String(body.dialogRedirectUri ?? "");
  if (dialogRedirect.length < 1200 && /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//.test(dialogRedirect)) {
    redirectUris.push(dialogRedirect, dialogRedirect.split("#")[0]);
  }
  if (base) {
    const settingsUrl = `${base}/settings/whatsapp`;
    if (pageUrl.startsWith(settingsUrl) && pageUrl.length < 300) redirectUris.push(pageUrl);
    redirectUris.push(settingsUrl, `${settingsUrl}/`, `${base}/`);
  }

  const exchanged = await deps.embeddedSignup.exchangeCode(code, { redirectUris: [...new Set(redirectUris)] });
  if (!exchanged.ok) {
    log("embedded_signup_failed", {
      businessId: actor.businessId,
      reason: exchanged.reason,
      idsFromBrowser: Boolean(phoneNumberId && wabaId),
      metaCode: exchanged.meta?.code ?? null,
      metaSubcode: exchanged.meta?.subcode ?? null,
      metaMessage: exchanged.meta?.message ?? null,
    });
    return refuse(exchanged.reason === SIGNUP_FAILURES.NETWORK_ERROR ? 502 : 400, exchanged.reason);
  }
  const accessToken = exchanged.accessToken;

  // The browser did not say which number was chosen. Ask Meta what this
  // token was actually granted instead of guessing. Exactly one usable
  // number is connected; anything else is refused, because picking one of
  // several is exactly the assumption that files one tenant's traffic
  // under another.
  if ((!phoneNumberId || !wabaId) && deps.embeddedSignup.discoverAssets) {
    const found = await deps.embeddedSignup.discoverAssets(accessToken);
    const candidates = found.candidates ?? [];
    const free = [];
    const takenElsewhere = [];
    for (const c of candidates) {
      const owner = await deps.integrations.byPhoneNumberId?.(c.phoneNumberId);
      if (owner && owner.businessId !== actor.businessId) takenElsewhere.push(c);
      else free.push(c);
    }
    log("embedded_signup_discovered", {
      businessId: actor.businessId,
      ok: Boolean(found.ok),
      wabaCount: found.wabaCount ?? 0,
      numbers: candidates.length,
      free: free.length,
      takenElsewhere: takenElsewhere.length,
    });
    if (free.length === 1) {
      phoneNumberId = free[0].phoneNumberId;
      wabaId = free[0].wabaId;
    } else if (free.length === 0 && takenElsewhere.length > 0) {
      return refuse(409, SIGNUP_FAILURES.NUMBER_TAKEN);
    } else {
      return refuse(400, SIGNUP_FAILURES.MISSING_ASSETS);
    }
  }
  if (!phoneNumberId || !wabaId) return refuse(400, SIGNUP_FAILURES.MISSING_ASSETS);

  // Both best-effort, both reported. Neither can make a connection
  // CONNECTED and neither failing is allowed to discard a token the
  // customer just authorised — verification below is the judge.
  const registered = await deps.embeddedSignup.registerNumber(phoneNumberId, accessToken);
  const subscribed = await deps.embeddedSignup.subscribeApp(wabaId, accessToken);
  const described = await deps.embeddedSignup.describeNumber(phoneNumberId, accessToken);

  let integration;
  try {
    integration = await deps.integrations.register({
      businessId: actor.businessId,
      phoneNumberId,
      wabaId,
      displayPhoneNumber: described.displayPhoneNumber,
      accessToken,
      // Not collected and not needed per business: Meta signs webhooks
      // with the APP secret and verifies the callback with the app's own
      // verify token, both of which belong to this platform's Meta app.
      // Storing empty strings is the honest record of that.
      appSecret: "",
      verifyToken: "",
      status: "CONFIGURED",
      // Embedded Signup tokens expire (60 days); recorded so sends can
      // refresh ahead of it and the settings page can warn.
      tokenExpiresAt: expiryFromSeconds(exchanged.expiresIn),
    });
    log("integration_registered", { businessId: actor.businessId, via: "embedded_signup" });
  } catch (err) {
    logError("integration_register_failed", err, { businessId: actor.businessId, via: "embedded_signup" });
    return refuse(409, SIGNUP_FAILURES.NUMBER_TAKEN);
  }

  // The customer's own WABA needs the missed-call template before a single
  // send can work. Submitting it is best-effort and only a REQUEST: Meta's
  // approval follows in minutes to a day, so this records what was asked,
  // never that it is usable.
  const templateName = deps.config?.WHATSAPP_MISSED_CALL_TEMPLATE || "missed_call_immediate";
  let template = { ok: false, skipped: true };
  if (deps.embeddedSignup.ensureTemplate) {
    template = await deps.embeddedSignup.ensureTemplate(wabaId, accessToken, {
      name: templateName,
      language: deps.config?.WHATSAPP_TEMPLATE_LANGUAGE || "en",
    });
    if (!template.skipped && deps.integrations.noteTemplate) {
      integration = await deps.integrations.noteTemplate(integration, {
        name: templateName,
        state: template.ok ? (template.existing ? "existing" : "submitted") : "failed",
      });
    }
    // The owner's lead alert needs its own template: plain text never
    // reaches an owner who hasn't messaged the business number in the last
    // 24 hours. Best-effort like the one above; until Meta approves it,
    // alerts fall back to text (lib/ownerAlert.mjs).
    const alert = await deps.embeddedSignup.ensureTemplate(wabaId, accessToken, {
      name: OWNER_ALERT_TEMPLATE,
      language: deps.config?.WHATSAPP_TEMPLATE_LANGUAGE || "en",
    });
    if (!alert.ok && !alert.skipped) log("owner_alert_template_failed", { businessId: actor.businessId });
  }

  const result = await verifyStored(deps, integration, {
    phoneNumberId,
    wabaId,
    accessToken,
    businessId: actor.businessId,
  });

  log("embedded_signup_completed", {
    businessId: actor.businessId,
    verified: result.ok,
    registered: registered.ok,
    registerSkipped: Boolean(registered.skipped),
    subscribed: subscribed.ok,
    template: template.skipped ? "skipped" : template.ok ? (template.existing ? "existing" : "submitted") : "failed",
  });

  // Safe metadata only. No token, no code, no WABA id — the settings page
  // reads the stored record for everything it displays.
  return {
    status: 200,
    body: {
      ok: result.ok,
      connected: result.ok,
      redirect: `/settings/whatsapp?v=${encodeURIComponent(result.ok ? "ok" : result.reason)}`,
      displayPhoneNumber: described.displayPhoneNumber,
    },
  };
}

/**
 * POST /settings/whatsapp/test — re-verify what is already stored.
 *
 * Exists so "Test Connection" means something: it decrypts the stored
 * credentials in memory, asks Meta the same two questions as the original
 * verification, and updates the persisted status either way. The customer
 * never re-enters anything, and nothing is displayed back to them beyond
 * the outcome sentence.
 */
export async function handleWhatsappTest(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor?.businessId) return redirect(SIGN_IN);

  if (!can(actor.role, "manageSettings")) {
    log("settings_change_denied", { role: actor.role });
    return redirect("/settings/whatsapp");
  }

  const integration = await deps.integrations.forBusiness(actor.businessId);
  if (!integration?.phoneNumberId) {
    return redirect(`/settings/whatsapp?e=${SIGNUP_FAILURES.MISSING_ASSETS}`);
  }

  const secrets = deps.integrations.secretsOf(integration);
  const result = await verifyStored(deps, integration, {
    phoneNumberId: integration.phoneNumberId,
    wabaId: integration.wabaId,
    accessToken: secrets?.accessToken ?? "",
    businessId: actor.businessId,
  });

  return redirect(`/settings/whatsapp?v=${encodeURIComponent(result.ok ? "ok" : result.reason)}`);
}

/**
 * POST /settings/whatsapp/templates — create the message templates this
 * platform knows the wording of, in the connected business's own WABA.
 *
 * Connecting already asks for the missed-call template, but that request
 * is best-effort and the only way to retry it was to connect all over
 * again. This asks for every template in TEMPLATE_DEFINITIONS; one Meta
 * already has is reported as existing, never as an error.
 *
 * Creating a template only SUBMITS it — Meta approves it afterwards — so
 * the redirect carries three counts and the page says "sent for approval",
 * never "ready". No template name, WABA id or token is put in the URL.
 */
export async function handleWhatsappTemplates(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor?.businessId) return redirect(SIGN_IN);

  if (!can(actor.role, "manageSettings")) {
    log("settings_change_denied", { role: actor.role });
    return redirect("/settings/whatsapp");
  }

  const integration = await deps.integrations.forBusiness(actor.businessId);
  if (!integration?.wabaId || !deps.embeddedSignup?.ensureTemplate) {
    return redirect(`/settings/whatsapp?e=${SIGNUP_FAILURES.MISSING_ASSETS}`);
  }

  const accessToken = deps.integrations.secretsOf(integration)?.accessToken ?? "";
  const language = deps.config?.WHATSAPP_TEMPLATE_LANGUAGE || "en";
  const missedCallTemplate = deps.config?.WHATSAPP_MISSED_CALL_TEMPLATE || "missed_call_immediate";

  const counts = { submitted: 0, existing: 0, failed: 0 };
  let current = integration;
  for (const name of Object.keys(TEMPLATE_DEFINITIONS)) {
    const result = await deps.embeddedSignup.ensureTemplate(integration.wabaId, accessToken, { name, language });
    const state = result.ok ? (result.existing ? "existing" : "submitted") : "failed";
    counts[state] += 1;
    // The settings page reports on the one template sends depend on.
    if (name === missedCallTemplate && deps.integrations.noteTemplate) {
      current = await deps.integrations.noteTemplate(current, { name, state });
    }
  }

  log("whatsapp_templates_requested", { businessId: actor.businessId, ...counts });
  return redirect(`/settings/whatsapp?t=${counts.submitted}.${counts.existing}.${counts.failed}`);
}

/**
 * POST /settings/whatsapp/send-test — "show me what my callers get".
 *
 * Sends the business's own missed-call template to a number the signed-in
 * owner types, through reportMissedCall() — the same path the phone
 * automation uses, so the 10-minute dedupe, the plan allowance and the
 * usage count all apply. It is a real send, and the page says so.
 *
 * The number travels in the form body and is never put in the redirect;
 * the URL carries one marker from a fixed list.
 */
/**
 * Meta's error code for a refused send, turned into one of the fixed
 * markers the settings page explains. An owner who sees "did not accept"
 * cannot act on it; "add this number to the test list" they can.
 */
const META_SEND_ERRORS = {
  131030: "allowlist", // Meta's free test number: recipient not on its allowed list
  131026: "notwa", // recipient is not on WhatsApp / cannot receive
  132000: "template", // template parameter mismatch
  132001: "template", // template does not exist / not approved in this language
  132015: "template", // template paused
  132016: "template", // template disabled
  131042: "payment", // no valid payment method on the WhatsApp account
  133010: "unregistered", // the business number is not registered with Cloud API
  190: "token", // access token expired or revoked
  131056: "busy", // too many messages to this pair in a short time
  130429: "busy", // throughput limit
};

export function testFailureMarker(metaCode) {
  return META_SEND_ERRORS[Number(metaCode)] ?? "failed";
}

export async function handleWhatsappSendTest(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor?.businessId) return redirect(SIGN_IN);

  if (!can(actor.role, "manageSettings")) {
    log("settings_change_denied", { role: actor.role });
    return redirect("/settings/whatsapp");
  }

  const business = deps.businesses?.byId(actor.businessId) ?? null;
  if (!business) return redirect("/settings/whatsapp");

  const typed = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "").get("number") ?? "";
  const callerNumber = typed.replace(/[\s()-]/g, "");

  const result = await reportMissedCall(business, { callerNumber }, deps);
  const body = result.body ?? {};
  const outcome = body.sent ? "sent"
    : body.deduped ? "wait"
    : body.reason ? "own"
    : result.status === 400 ? "number"
    : result.status === 402 ? "limit"
    : result.status === 503 ? "unconnected"
    : testFailureMarker(body.metaError?.code);

  log("whatsapp_test_message", { businessId: actor.businessId, outcome, metaCode: body.metaError?.code ?? null });
  return redirect(`/settings/whatsapp?m=${outcome}`);
}

/**
 * Ask Meta, then record what Meta said.
 *
 * Shared by both routes so a connection made through Embedded Signup and
 * one made through Advanced Setup reach CONNECTED by exactly the same
 * evidence. With no verifier wired the integration stays CONFIGURED —
 * assuming success because we could not check is how a broken connection
 * gets reported as working.
 */
async function verifyStored(deps, integration, { phoneNumberId, wabaId, accessToken, businessId }) {
  if (!deps.metaVerifier) {
    log("integration_verification_skipped", { businessId, reason: "no verifier wired" });
    return { ok: false, reason: "not_verified" };
  }

  const result = await deps.metaVerifier.verify({ phoneNumberId, wabaId, accessToken });

  if (result.ok) {
    await deps.integrations.markVerified(integration);
    log("integration_verified", { businessId });
    return { ok: true, reason: null };
  }

  await deps.integrations.markVerificationFailed(integration, result.reason);
  log("integration_verification_failed", {
    businessId,
    reason: result.reason,
    metaCode: result.meta?.code ?? null,
    metaMessage: result.meta?.message ?? null,
  });
  return { ok: false, reason: result.reason };
}
