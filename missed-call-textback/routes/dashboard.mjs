import { currentSession, createSession, verifyPassword, sessionCookie, clearedCookie, parseCookies, loginRateLimited, COOKIE_NAME } from "../lib/auth.mjs";
import { loginPage, dashboardPage, leadDetailPage } from "../lib/views.mjs";
import { isValidStatus, isValidPriority, canTransition, formatOwnerNotification } from "../lib/leads.mjs";
import { createMessage, providerMessageId } from "../lib/messages.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { resolveActor, can } from "../lib/users.mjs";
import { clientForBusiness } from "../lib/outbound.mjs";
import { deleteLead } from "../lib/deleteLead.mjs";
import { landingPage } from "../lib/landing.mjs";
import { PLAN_ENTITLEMENTS, formatPrice } from "../lib/billing.mjs";
import { log } from "../lib/logger.mjs";

/**
 * GET / — the public pitch. No auth, no customer data on it.
 *
 * Plan prices and limits are read from the billing configuration rather
 * than written into the page, so the pitch cannot end up advertising a
 * price or an allowance the product no longer offers.
 */
export function handleLanding(ctx, { config }) {
  const plans = Object.fromEntries(
    ["FREE", "PRO"].map((name) => [name, {
      price: formatPrice(name),
      leads: PLAN_ENTITLEMENTS[name].leadsPerMonth,
      messages: PLAN_ENTITLEMENTS[name].messagesPerMonth,
    }])
  );
  return { status: 200, html: landingPage({ businessName: config.BUSINESS_NAME || "", plans }) };
}

/** GET /leads — the leads dashboard, or the login form when there's no valid session. */
export async function handleDashboard(ctx, deps) {
  const { store, config } = deps;
  if (!config.DASHBOARD_PASSWORD_HASH) {
    return { status: 503, html: loginPage({ error: "Dashboard password is not configured." }) };
  }
  const session = await currentSession(ctx, store);
  if (!session) return { status: 200, html: loginPage() };

  const query = {
    q: ctx.query?.get("q") ?? "",
    status: ctx.query?.get("status") ?? "",
    urgency: ctx.query?.get("urgency") ?? "",
  };

  // Leads are read through a store scoped to the session's business, so
  // the dashboard cannot return another tenant's data even if a filter is
  // wrong — the keys simply aren't reachable.
  const tenant = await tenantFor(session, deps);
  if (!tenant) return noTenantResult(session);

  const leads = await tenant.store.listLeads();
  return {
    status: 200,
    html: dashboardPage(leads, query, { deleted: ctx.query?.get("deleted") === "1" }),
  };
}

/**
 * Resolves the tenant a signed-in session is allowed to touch, or null.
 *
 * The business comes from the stored membership, never from the request,
 * so a crafted query string can't select someone else's tenant — and
 * never from a default, either. An earlier version fell back to the
 * `default` business whenever the session named none, which meant anyone
 * who signed up and had not yet created a business was handed the default
 * tenant's leads. A session that does not resolve to a business gets
 * nothing; "which tenant?" has no sensible default answer.
 *
 * Membership is re-read on every request rather than trusted from the
 * session, so removing someone from a business ends their access now
 * instead of whenever their cookie happens to expire.
 */
async function tenantFor(session, { store, businesses, accounts }) {
  const actor = await resolveActor(session, accounts);
  if (!actor?.businessId) return null;

  if (!businesses) return { actor, business: null, store };
  const business = businesses.byId(actor.businessId);
  if (!business) return null;
  return { actor, business, store: scopedToBusiness(store, business.id) };
}

/** What a session that resolves to no tenant should be shown. */
function noTenantResult(session) {
  // Signed in but with no business yet: onboarding, not an error.
  if (session?.userId) return { status: 302, headers: { Location: "/onboarding" }, body: {} };
  return { status: 200, html: loginPage({ error: "That session is no longer valid. Please sign in again." }) };
}

/**
 * GET /lead?id=… — one lead with its full transcript.
 *
 * The lead is fetched through the session's tenant-scoped store, so an id
 * belonging to another business simply doesn't resolve — there is no
 * separate ownership check to forget.
 */
export async function handleLeadDetail(ctx, deps) {
  const { store, config } = deps;
  if (!config.DASHBOARD_PASSWORD_HASH) {
    return { status: 503, html: loginPage({ error: "Dashboard password is not configured." }) };
  }
  const session = await currentSession(ctx, store);
  if (!session) return { status: 200, html: loginPage() };

  const tenant = await tenantFor(session, deps);
  if (!tenant) return noTenantResult(session);

  const id = ctx.query?.get("id") ?? "";
  const lead = await tenant.store.getLead(id);
  if (!lead) return { status: 404, html: dashboardPage(await tenant.store.listLeads(), {}) };

  // Older leads predate transcript storage; an empty list renders a plain
  // note rather than inventing history that was never recorded.
  const messages = tenant.store.listMessages ? await tenant.store.listMessages(lead.callerNumber) : [];
  return {
    status: 200,
    html: leadDetailPage(lead, messages, {
      canDelete: can(tenant.actor.role, "manageSettings"),
      role: tenant.actor.role,
    }),
  };
}

/**
 * POST /leads/status — moves one lead along the follow-up flow.
 *
 * Session-gated like the dashboard itself, and the status is checked
 * against the known set rather than written through, so a crafted form
 * post can't put arbitrary values on a lead.
 */
export async function handleLeadStatus(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { status: 302, headers: { Location: "/leads" }, body: {} };

  // Same scoping as the read path: a lead id from another tenant simply
  // doesn't resolve here, so it can't be mutated across the boundary.
  const tenant = await tenantFor(session, deps);
  if (!tenant) return noTenantResult(session);
  const tenantStore = tenant.store;

  const form = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
  const id = form.get("id") ?? "";
  const status = form.get("status") ?? "";
  const back = form.get("back") ?? "";

  if (!isValidStatus(status)) {
    log("lead_status_rejected", { reason: "unknown status" });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  const lead = await tenantStore.getLead(id);
  if (!lead) {
    log("lead_status_rejected", { reason: "unknown lead" });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  // The transition itself is validated, not just the destination value —
  // otherwise a lead could jump straight from new to completed and the
  // workflow would record something that never happened.
  const current = isValidStatus(lead.status) ? lead.status : "new";
  if (current !== status && !canTransition(current, status)) {
    log("lead_status_rejected", { reason: "invalid transition", from: current, to: status });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  const now = new Date().toISOString();
  await tenantStore.saveLead({
    ...lead,
    status,
    updatedAt: now,
    statusChangedAt: current === status ? (lead.statusChangedAt ?? now) : now,
    lastActivityAt: now,
  });
  log("lead_status_changed", { leadId: id, from: current, to: status });

  // `back` only ever carries our own filter params; rebuilding it through
  // URLSearchParams keeps a crafted value from turning into an open redirect.
  const params = new URLSearchParams(back).toString();
  return { status: 302, headers: { Location: params ? `/leads?${params}` : "/leads" }, body: {} };
}

/**
 * POST /lead/priority — flips a lead between NORMAL and URGENT.
 *
 * Separate from status on purpose: how fast this needs attention is a
 * different question from where it sits in the follow-up workflow.
 */
export async function handleLeadPriority(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { status: 302, headers: { Location: "/leads" }, body: {} };

  const tenant = await tenantFor(session, deps);
  if (!tenant) return noTenantResult(session);
  const tenantStore = tenant.store;
  const form = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
  const id = form.get("id") ?? "";
  const priority = form.get("priority") ?? "";

  if (!isValidPriority(priority)) {
    log("lead_priority_rejected", { reason: "unknown priority" });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  const lead = await tenantStore.getLead(id);
  if (!lead) {
    log("lead_priority_rejected", { reason: "unknown lead" });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  const now = new Date().toISOString();
  await tenantStore.saveLead({ ...lead, priority, updatedAt: now, lastActivityAt: now });
  log("lead_priority_changed", { leadId: id, priority });

  return { status: 302, headers: { Location: `/lead?id=${encodeURIComponent(id)}` }, body: {} };
}

/**
 * POST /lead/retry-notify — resends the owner alert for one existing lead.
 *
 * Deliberately narrow: it re-sends the notification and nothing else. It
 * does not touch the lead's status, does not re-run the conversation, and
 * cannot create a lead — the lead must already exist to be found. On
 * success `ownerNotified` flips to true; on failure it stays false so the
 * dashboard keeps showing the lead as undelivered rather than quietly
 * claiming success.
 */
export async function handleRetryNotification(ctx, deps) {
  const { store, config } = deps;
  const session = await currentSession(ctx, store);
  if (!session) return { status: 302, headers: { Location: "/leads" }, body: {} };

  const tenant = await tenantFor(session, deps);
  if (!tenant) return noTenantResult(session);
  const tenantStore = tenant.store;

  const form = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
  const id = form.get("id") ?? "";

  const lead = await tenantStore.getLead(id);
  if (!lead) {
    log("notification_retry_rejected", { reason: "unknown lead" });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  const business = tenant.business;
  const destination = business?.ownerWhatsApp ?? config.MOHAMED_WHATSAPP_NUMBER;

  // The retry goes out on this business's own integration. If it has none,
  // nothing is sent: a notification delivered from another tenant's
  // WhatsApp number is worse than one that visibly failed.
  const client = await clientForBusiness(tenant.actor.businessId, deps);
  if (!client) {
    log("notification_retry_failed", { leadId: id, reason: "no integration for this business" });
    await tenantStore.saveLead({ ...lead, ownerNotified: false, updatedAt: new Date().toISOString() });
    return { status: 302, headers: { Location: `/lead?id=${encodeURIComponent(id)}` }, body: {} };
  }

  const result = await client.sendText(destination, formatOwnerNotification(lead));
  const ownerNotified = result?.ok !== false;

  if (tenantStore.saveMessage) {
    await tenantStore.saveMessage(
      createMessage({
        conversationId: lead.callerNumber,
        leadId: lead.id,
        direction: "outbound",
        senderType: "owner",
        customerPhone: lead.callerNumber,
        messageId: providerMessageId(result),
        text: formatOwnerNotification(lead),
        metadata: { accepted: ownerNotified, retry: true, to: destination },
      })
    );
  }

  const now = new Date().toISOString();
  await tenantStore.saveLead({ ...lead, ownerNotified, updatedAt: now, lastActivityAt: now });
  log(ownerNotified ? "notification_retry_succeeded" : "notification_retry_failed", { leadId: id });

  return { status: 302, headers: { Location: `/lead?id=${encodeURIComponent(id)}` }, body: {} };
}

/**
 * POST /lead/delete — permanently removes one lead.
 *
 * A POST rather than a GET because it changes state, and the session
 * cookie is `SameSite=Strict`, which is this project's existing CSRF
 * convention for every other mutating route (`/leads/status`,
 * `/lead/priority`, `/lead/retry-notify`). A `confirm=delete` field is
 * required on top, so a stray or replayed POST cannot destroy data on its
 * own.
 *
 * The business is resolved from the session's membership. `businessId`,
 * `tenantId` and `ownerId` in the body are not validated — they are never
 * read. A lead belonging to another tenant is reported as 404, because
 * "403 Forbidden" would confirm that the id exists.
 */
export async function handleLeadDelete(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { status: 401, body: { error: "not signed in" } };

  const tenant = await tenantFor(session, deps);
  if (!tenant) return { status: 403, body: { error: "no business for this account" } };

  // Deleting a customer's record is an owner/admin action.
  if (!can(tenant.actor.role, "manageSettings")) {
    log("lead_delete_denied", { role: tenant.actor.role });
    return { status: 403, body: { error: "your role cannot delete leads" } };
  }

  const form = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
  const id = form.get("id") ?? "";
  if (form.get("confirm") !== "delete") {
    return { status: 400, body: { error: "deletion must be confirmed" } };
  }

  const result = await deleteLead({
    store: tenant.store,
    businessId: tenant.actor.businessId,
    leadId: id,
    actor: tenant.actor,
  });

  if (!result.deleted) {
    // Already gone, never existed, or belongs to someone else — all
    // indistinguishable from here, deliberately. Repeating a delete is
    // safe and lands here.
    return { status: 404, body: { error: "lead not found" } };
  }

  return {
    status: 302,
    headers: { Location: "/leads?deleted=1" },
    body: {},
  };
}

/** POST /login — verifies the password and starts a session. */
export async function handleLogin(ctx, { store, config, businesses, accounts }) {
  if (!config.DASHBOARD_PASSWORD_HASH) {
    return { status: 503, html: loginPage({ error: "Dashboard password is not configured." }) };
  }

  if (await loginRateLimited(ctx, store)) {
    log("dashboard_login_rate_limited", {});
    return { status: 429, html: loginPage({ error: "Too many attempts. Try again later." }) };
  }

  const submitted = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "").get("password") ?? "";

  // The credential decides the tenant. Binding the session to whichever
  // business owns the password is what keeps a second tenant's login from
  // landing in the first tenant's data — and it means the browser never
  // gets to nominate a businessId at all.
  const email = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "").get("email") ?? "";

  // A real account signs in with email + password and gets a session
  // carrying its user id; the business and role are then resolved from
  // the stored membership on every request.
  if (email && accounts) {
    const user = await accounts.authenticate({ email, password: submitted });
    if (!user) {
      log("dashboard_login_failed", {});
      return { status: 401, html: loginPage({ error: "Incorrect email or password." }) };
    }
    const memberships = await accounts.membershipsOf(user.id);
    const first = memberships[0] ?? null;
    const id = await createSession(store, first?.businessId ?? null, { userId: user.id });
    log("dashboard_login_succeeded", { hasBusiness: Boolean(first) });
    return {
      status: 302,
      headers: { Location: first ? "/leads" : "/onboarding", "Set-Cookie": sessionCookie(id) },
      body: {},
    };
  }

  // TODO(remove): legacy per-business credential, kept so the existing
  // default business keeps working until it has a real account.
  const business = businesses?.byPassword(submitted, verifyPassword) ?? null;
  const authorised = businesses ? Boolean(business) : verifyPassword(submitted, config.DASHBOARD_PASSWORD_HASH);

  if (!authorised) {
    log("dashboard_login_failed", {});
    return { status: 401, html: loginPage({ error: "Incorrect password." }) };
  }

  const id = await createSession(store, business?.id ?? "default");
  log("dashboard_login_succeeded", { businessId: business?.id ?? "default" });
  return {
    status: 302,
    headers: { Location: "/leads", "Set-Cookie": sessionCookie(id) },
    body: {},
  };
}

/** POST /logout — destroys the session server-side, not just the cookie. */
export async function handleLogout(ctx, { store }) {
  const id = parseCookies(ctx.headers?.cookie)[COOKIE_NAME];
  if (id) await store.deleteSession(id);
  return {
    status: 302,
    headers: { Location: "/leads", "Set-Cookie": clearedCookie() },
    body: {},
  };
}
