/**
 * Self-service accounts, onboarding and settings.
 *
 * Authorization is always: session -> membership -> role. A businessId or
 * role arriving in a request body is ignored entirely rather than
 * checked, because the only safe way to handle client-supplied authority
 * is not to read it.
 */
import { currentSession, createSession, sessionCookie, loginRateLimited, COOKIE_NAME, parseCookies } from "../lib/auth.mjs";
import { resolveActor, can, isValidRole, isValidEmail, isAcceptablePassword, normaliseEmail } from "../lib/users.mjs";
import { businessRecord, onboardingStatus } from "../lib/businesses.mjs";
import { publicView, integrationState } from "../lib/integrations.mjs";
import { VERIFIED_MESSAGE, FAILURE_MESSAGES } from "../lib/metaVerify.mjs";
import {
  signupPage, onboardingPage, whatsappSettingsPage, teamSettingsPage,
} from "../lib/settingsViews.mjs";
import { log, logError } from "../lib/logger.mjs";
import crypto from "node:crypto";

const redirect = (to) => ({ status: 302, headers: { Location: to }, body: {} });

const formOf = (ctx) => new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");

/** Resolves the acting user/business/role, or null. */
async function actorFor(ctx, { store, accounts }) {
  const session = await currentSession(ctx, store);
  return resolveActor(session, accounts);
}

// ---------------------------------------------------------------- signup

export function handleSignupGet() {
  return { status: 200, html: signupPage() };
}

export async function handleSignupPost(ctx, deps) {
  const { store, accounts } = deps;

  if (await loginRateLimited(ctx, store)) {
    return { status: 429, html: signupPage({ error: "Too many attempts. Try again later." }) };
  }

  const form = formOf(ctx);
  const email = form.get("email") ?? "";
  const password = form.get("password") ?? "";

  if (!isValidEmail(email)) return { status: 400, html: signupPage({ error: "Enter a valid email address.", email }) };
  if (!isAcceptablePassword(password)) {
    return { status: 400, html: signupPage({ error: "Password must be at least 10 characters.", email }) };
  }

  const user = await accounts.signUp({ email, password });
  if (!user) {
    // Deliberately the same message whether the email is taken or the
    // input was rejected — signup must not reveal who already has an account.
    return { status: 400, html: signupPage({ error: "Could not create that account.", email }) };
  }

  const sessionId = await createSession(store, null, { userId: user.id });
  log("account_created", {});
  return { status: 302, headers: { Location: "/onboarding", "Set-Cookie": sessionCookie(sessionId) }, body: {} };
}

// ------------------------------------------------------------ onboarding

export async function handleOnboardingGet(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session?.userId) return redirect("/signup");

  const memberships = await deps.accounts.membershipsOf(session.userId);
  if (memberships.length) return redirect("/leads");
  return { status: 200, html: onboardingPage() };
}

export async function handleOnboardingPost(ctx, deps) {
  const { store, accounts } = deps;
  const session = await currentSession(ctx, store);
  if (!session?.userId) return redirect("/signup");

  const user = await store.getUser(session.userId);
  if (!user) return redirect("/signup");

  const form = formOf(ctx);
  const name = (form.get("name") ?? "").trim();
  if (!name) return { status: 400, html: onboardingPage({ error: "Business name is required." }) };

  const business = businessRecord({
    // Server-generated: a client cannot choose a business id and so cannot
    // collide with, or impersonate, an existing tenant.
    id: crypto.randomUUID(),
    name,
    industry: (form.get("industry") ?? "").trim(),
    businessPhone: (form.get("businessPhone") ?? "").trim(),
    timezone: (form.get("timezone") ?? "Asia/Kolkata").trim(),
    ownerName: (form.get("ownerName") ?? "").trim(),
    ownerWhatsApp: (form.get("ownerWhatsApp") ?? "").trim(),
    areas: (form.get("areas") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    services: (form.get("services") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });

  await accounts.createBusinessFor(user, business);

  // Re-issue the session now bound to the business the user just created.
  const sessionId = await createSession(store, business.id, { userId: user.id });
  log("business_created", { businessId: business.id });

  return { status: 302, headers: { Location: "/settings/whatsapp", "Set-Cookie": sessionCookie(sessionId) }, body: {} };
}

// ------------------------------------------------- WhatsApp settings UI

export async function handleWhatsappSettingsGet(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor) return redirect("/login");

  const business = deps.businesses?.byId(actor.businessId) ?? null;
  const integration = await deps.integrations.forBusiness(actor.businessId);

  // The state shown is the state stored. It is not re-derived from the
  // business record, and it is certainly not read back out of the markup.
  const connection = integrationState(integration);

  return {
    status: 200,
    html: whatsappSettingsPage({
      business,
      // Safe metadata only — publicView never carries a credential, not
      // even the ciphertext.
      integration: publicView(integration),
      status: connection,
      onboarding: onboardingStatus(business ?? {}, { connection }),
      verification: verificationNotice(ctx.query?.get("v")),
      canManage: can(actor.role, "manageSettings"),
      role: actor.role,
      actor,
    }),
  };
}

/** Turns the ?v= marker left by a redirect back into something readable. */
function verificationNotice(code) {
  if (!code) return null;
  if (code === "ok") return { ok: true, message: VERIFIED_MESSAGE };
  return { ok: false, message: FAILURE_MESSAGES[code] ?? "Verification failed." };
}

export async function handleWhatsappSettingsPost(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor) return redirect("/login");

  if (!can(actor.role, "manageSettings")) {
    log("settings_change_denied", { role: actor.role });
    return { status: 403, html: whatsappSettingsPage({ error: "Your role cannot change integration settings." }) };
  }

  const form = formOf(ctx);
  const phoneNumberId = (form.get("phoneNumberId") ?? "").trim();
  const accessToken = (form.get("accessToken") ?? "").trim();

  if (!phoneNumberId || !accessToken) {
    return { status: 400, html: whatsappSettingsPage({ error: "Phone number ID and access token are required." }) };
  }

  const wabaId = (form.get("wabaId") ?? "").trim();
  let integration;

  try {
    integration = await deps.integrations.register({
      // The business comes from the membership, never from the form.
      businessId: actor.businessId,
      phoneNumberId,
      wabaId,
      displayPhoneNumber: (form.get("displayPhoneNumber") ?? "").trim(),
      accessToken,
      appSecret: (form.get("appSecret") ?? "").trim(),
      verifyToken: (form.get("verifyToken") ?? "").trim(),
      // Never CONNECTED on save: credentials that have not been exercised
      // against Meta are configuration, not a working connection.
      status: "CONFIGURED",
    });
    log("integration_registered", { businessId: actor.businessId });
  } catch (err) {
    logError("integration_register_failed", err, { businessId: actor.businessId });
    return {
      status: 409,
      html: whatsappSettingsPage({ error: "That WhatsApp number is already registered to another business." }),
    };
  }

  // Now ask Meta whether any of this is true. The credentials are already
  // stored — storing them is what lets the owner correct a typo — but the
  // integration stays CONFIGURED until Meta itself confirms it, and moves
  // to ERROR if Meta says no. Storing a credential is not evidence of
  // anything, and this is the only place CONNECTED can come from.
  if (!deps.metaVerifier) {
    log("integration_verification_skipped", { businessId: actor.businessId, reason: "no verifier wired" });
    return redirect("/settings/whatsapp");
  }

  const result = await deps.metaVerifier.verify({ phoneNumberId, wabaId, accessToken });

  if (result.ok) {
    await deps.integrations.markVerified(integration);
    log("integration_verified", { businessId: actor.businessId });
  } else {
    await deps.integrations.markVerificationFailed(integration, result.reason);
    // Meta's own code and message are API metadata, not credentials, and
    // without them "verification failed" is undiagnosable.
    log("integration_verification_failed", {
      businessId: actor.businessId,
      reason: result.reason,
      metaCode: result.meta?.code ?? null,
      metaMessage: result.meta?.message ?? null,
    });
  }

  return redirect(`/settings/whatsapp?v=${encodeURIComponent(result.ok ? "ok" : result.reason)}`);
}

// --------------------------------------------------------- team settings

export async function handleTeamGet(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor) return redirect("/login");

  const memberships = await deps.accounts.membersOf(actor.businessId);
  const members = [];
  for (const m of memberships) {
    const user = await deps.store.getUser(m.userId);
    members.push({ id: m.id, role: m.role, email: user?.email ?? "(unknown)", createdAt: m.createdAt });
  }

  return {
    status: 200,
    html: teamSettingsPage({ members, canManage: can(actor.role, "manageTeam"), role: actor.role }),
  };
}

export async function handleTeamPost(ctx, deps) {
  const actor = await actorFor(ctx, deps);
  if (!actor) return redirect("/login");

  if (!can(actor.role, "manageTeam")) {
    log("team_change_denied", { role: actor.role });
    return { status: 403, html: teamSettingsPage({ error: "Only the owner can manage team members." }) };
  }

  const form = formOf(ctx);
  const action = form.get("action") ?? "";

  if (action === "remove") {
    await deps.accounts.removeMember({ businessId: actor.businessId, membershipId: form.get("membershipId") ?? "" });
    return redirect("/settings/team");
  }

  const role = form.get("role") ?? "";
  if (!isValidRole(role) || role === "OWNER") {
    return { status: 400, html: teamSettingsPage({ error: "Choose ADMIN or STAFF." }) };
  }

  const added = await deps.accounts.addMember({
    businessId: actor.businessId,
    email: normaliseEmail(form.get("email") ?? ""),
    role,
  });

  if (!added) {
    // No invitation email infrastructure exists, so a member must already
    // have signed up. Said plainly rather than faking an invite.
    return {
      status: 400,
      html: teamSettingsPage({ error: "No account with that email. They must sign up first — invitations aren't available yet." }),
    };
  }

  return redirect("/settings/team");
}
