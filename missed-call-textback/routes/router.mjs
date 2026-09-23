/**
 * One dispatch table, shared by the local server and the Vercel function.
 *
 * Two reasons this exists rather than a file per route:
 *
 * 1. Vercel's Hobby plan caps a deployment at 12 serverless functions, and
 *    a route-per-file layout blew past it. The browser-facing pages are
 *    cheap to group; the webhook and missed-call endpoints stay in their
 *    own functions because they are the externally-called, latency- and
 *    reliability-sensitive ones.
 * 2. Keeping one table means the two environments cannot drift. They did
 *    once already: a wrapper that quietly omitted `query` made every
 *    dashboard filter a silent no-op in production while every local test
 *    passed.
 */
import { handleHealth } from "./health.mjs";
import {
  handleLanding, handleDashboard, handleLeadDetail, handleLeadStatus,
  handleLeadPriority, handleRetryNotification, handleLogin, handleLogout,
} from "./dashboard.mjs";
import {
  handleSignupGet, handleSignupPost, handleOnboardingGet, handleOnboardingPost,
  handleWhatsappSettingsGet, handleWhatsappSettingsPost, handleTeamGet, handleTeamPost,
} from "./accounts.mjs";
import { handleBillingGet } from "./billing.mjs";

/** Paths whose bodies are form-encoded or signature-verified, never JSON. */
export const NON_JSON_POSTS = new Set([
  "/webhook", "/login", "/logout", "/leads/status", "/lead/priority",
  "/lead/retry-notify", "/signup", "/onboarding", "/settings/whatsapp", "/settings/team",
]);

const ROUTES = [
  ["GET", "/health", handleHealth],
  ["GET", "/", handleLanding],
  ["GET", "/leads", handleDashboard],
  ["GET", "/lead", handleLeadDetail],
  ["POST", "/leads/status", handleLeadStatus],
  ["POST", "/lead/priority", handleLeadPriority],
  ["POST", "/lead/retry-notify", handleRetryNotification],
  ["POST", "/login", handleLogin],
  ["POST", "/logout", handleLogout],
  ["GET", "/signup", handleSignupGet],
  ["POST", "/signup", handleSignupPost],
  ["GET", "/onboarding", handleOnboardingGet],
  ["POST", "/onboarding", handleOnboardingPost],
  ["GET", "/settings/whatsapp", handleWhatsappSettingsGet],
  ["POST", "/settings/whatsapp", handleWhatsappSettingsPost],
  ["GET", "/settings/billing", handleBillingGet],
  ["GET", "/settings/team", handleTeamGet],
  ["POST", "/settings/team", handleTeamPost],
];

/** Resolves one request, or null when nothing matches. */
export async function dispatch(ctx, deps) {
  const route = ROUTES.find(([method, path]) => method === ctx.method && path === ctx.pathname);
  if (!route) return null;
  return route[2](ctx, deps);
}
