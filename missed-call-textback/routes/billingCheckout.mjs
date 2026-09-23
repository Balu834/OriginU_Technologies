/**
 * POST /billing/create-subscription — starts a Razorpay subscription.
 *
 * What this route can do: create a subscription at Razorpay against a
 * SERVER-configured plan id, record that checkout was started, and write
 * the provider -> tenant index.
 *
 * What it deliberately cannot do: grant a plan. The response says a
 * subscription was created, not that anything was paid. The only thing
 * that moves a business onto PRO is a signed webhook, and that is true
 * even though this route talks to Razorpay successfully — a 200 from
 * their API means "subscription created, awaiting authorisation", which
 * is not money.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor, can } from "../lib/users.mjs";
import { isCheckoutConfigured, planIdFor, publicConfig } from "../lib/razorpay.mjs";
import { isValidPlan } from "../lib/billing.mjs";
import { log, logError } from "../lib/logger.mjs";

/** Plans a customer may buy. FREE is not purchasable; BUSINESS is sales-led for now. */
const PURCHASABLE = new Set(["PRO"]);

export async function handleCreateSubscription(ctx, deps) {
  const { store, billing, razorpay, razorpayClient } = deps;

  const session = await currentSession(ctx, store);
  if (!session) return { status: 401, body: { error: "not signed in" } };

  // Tenant from the stored membership, as everywhere else. A businessId
  // in the body is not validated, it is simply never read.
  const actor = await resolveActor(session, deps.accounts);
  if (!actor?.businessId) return { status: 403, body: { error: "no business for this account" } };

  // Buying a plan is a settings-level action, not something any team
  // member can do on the business's behalf.
  if (!can(actor.role, "manageSettings")) {
    log("checkout_denied", { role: actor.role });
    return { status: 403, body: { error: "your role cannot change the plan" } };
  }

  // The plan comes from a fixed server-side set. The browser may say
  // WHICH of our plans it wants, but it can never name a Razorpay plan
  // id — that lookup happens here, against server configuration, so a
  // crafted request cannot subscribe to a cheaper plan than it displays.
  const requested = String(readPlan(ctx) || "PRO").toUpperCase();
  if (!isValidPlan(requested) || !PURCHASABLE.has(requested)) {
    return { status: 400, body: { error: "that plan cannot be purchased online" } };
  }

  if (!isCheckoutConfigured(razorpay)) {
    return { status: 503, body: { error: "payments are not configured yet" } };
  }
  const planId = planIdFor(razorpay, requested);
  if (!planId) {
    // Refuse rather than improvise. Without a configured Razorpay plan id
    // there is no price, and inventing one would be charging a customer
    // an amount nobody decided.
    logError("checkout_plan_not_configured", new Error("no razorpay plan id"), { plan: requested });
    return { status: 503, body: { error: `no price is configured for ${requested} yet` } };
  }

  // Don't let someone stack subscriptions by clicking twice.
  const existing = await billing.forBusiness(actor.businessId);
  if (existing && !existing.implicit && existing.providerSubscriptionId && isLive(existing.status)) {
    return {
      status: 409,
      body: { error: "this business already has an active subscription", status: existing.status },
    };
  }

  const created = await razorpayClient.createSubscription({
    planId,
    // Diagnostics only. Nothing reads this back as identity — see
    // routes/razorpayWebhook.mjs.
    notes: { businessId: actor.businessId },
  });

  if (!created.ok || !created.body?.id) {
    logError("checkout_create_failed", new Error(`status ${created.status}`), {
      businessId: actor.businessId, plan: requested,
    });
    return { status: 502, body: { error: "could not start checkout with the payment provider" } };
  }

  // Records the INTENT and the tenant mapping. Grants nothing.
  await billing.beginCheckout({
    businessId: actor.businessId,
    plan: requested,
    providerSubscriptionId: created.body.id,
  });
  log("checkout_started", { businessId: actor.businessId, plan: requested });

  return {
    status: 200,
    body: {
      subscriptionId: created.body.id,
      // Public key only — Razorpay's checkout widget needs it and it is
      // public by design. The key secret and webhook secret never leave
      // the server.
      keyId: publicConfig(razorpay).keyId,
      plan: requested,
      // Stated explicitly so no client can read this response as success.
      activated: false,
      message: "Subscription created. Your plan changes only after payment is confirmed.",
    },
  };
}

/** Accepts a plan NAME (ours), from a form post or JSON. Never a provider plan id. */
function readPlan(ctx) {
  if (ctx.json && typeof ctx.json === "object") return ctx.json.plan;
  const body = ctx.rawBody?.toString("utf8") ?? "";
  if (!body) return null;
  try {
    return JSON.parse(body).plan;
  } catch {
    return new URLSearchParams(body).get("plan");
  }
}

const isLive = (status) => status === "ACTIVE" || status === "TRIALING";
