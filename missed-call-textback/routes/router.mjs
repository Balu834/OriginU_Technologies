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
  handleLeadPriority, handleRetryNotification, handleLeadDelete, handleLoginPage, handleLogin, handleLogout,
} from "./dashboard.mjs";
import {
  handleSignupGet, handleSignupPost, handleOnboardingGet, handleOnboardingPost,
  handleWhatsappSettingsGet, handleWhatsappSettingsPost, handleTeamGet, handleTeamPost,
} from "./accounts.mjs";
import { handleBillingGet } from "./billing.mjs";
import { handleCreateSubscription } from "./billingCheckout.mjs";
import { handleBillingStatus } from "./billingStatus.mjs";
import { handleOverview } from "./overview.mjs";
import { handleBusinessSettingsGet, handleBusinessSettingsPost } from "./businessSettings.mjs";
import {
  handleWhatsappConnect, handleWhatsappTest, handleWhatsappTemplates, handleWhatsappSendTest,
} from "./whatsappConnect.mjs";
import { handlePrivacy, handleTerms, handleDataDeletion } from "./legal.mjs";
import { handlePhoneSetupGet, handlePhoneKeyPost } from "./phoneSetup.mjs";
import { handleForgotGet, handleForgotPost, handleResetGet, handleResetPost } from "./passwordReset.mjs";
import { handleGoogleStart, handleGoogleCallback } from "./googleAuth.mjs";
import { handleQrStart, handleQrStatus, handleQrLogout } from "./qrConnect.mjs";

/** Paths whose bodies are form-encoded or signature-verified, never JSON. */
export const NON_JSON_POSTS = new Set([
  "/webhook", "/login", "/logout", "/leads/status", "/lead/priority",
  "/lead/retry-notify", "/lead/delete", "/signup", "/onboarding", "/settings/whatsapp", "/settings/team",
  "/settings/business", "/settings/whatsapp/test", "/settings/whatsapp/templates", "/settings/whatsapp/send-test", "/settings/phone/key",
  "/settings/whatsapp/qr/start", "/settings/whatsapp/qr/logout",
  "/forgot-password", "/reset-password", "/ivr/missed-call",
]);

const ROUTES = [
  ["GET", "/health", handleHealth],
  ["GET", "/", handleLanding],
  ["GET", "/privacy", handlePrivacy],
  ["GET", "/terms", handleTerms],
  ["GET", "/data-deletion", handleDataDeletion],
  ["GET", "/dashboard", handleOverview],
  ["GET", "/leads", handleDashboard],
  ["GET", "/lead", handleLeadDetail],
  ["POST", "/leads/status", handleLeadStatus],
  ["POST", "/lead/priority", handleLeadPriority],
  ["POST", "/lead/retry-notify", handleRetryNotification],
  ["POST", "/lead/delete", handleLeadDelete],
  ["GET", "/login", handleLoginPage],
  ["POST", "/login", handleLogin],
  ["POST", "/logout", handleLogout],
  ["GET", "/auth/google", handleGoogleStart],
  ["GET", "/auth/google/callback", handleGoogleCallback],
  ["GET", "/forgot-password", handleForgotGet],
  ["POST", "/forgot-password", handleForgotPost],
  ["GET", "/reset-password", handleResetGet],
  ["POST", "/reset-password", handleResetPost],
  ["GET", "/signup", handleSignupGet],
  ["POST", "/signup", handleSignupPost],
  ["GET", "/onboarding", handleOnboardingGet],
  ["POST", "/onboarding", handleOnboardingPost],
  ["GET", "/settings/business", handleBusinessSettingsGet],
  ["POST", "/settings/business", handleBusinessSettingsPost],
  ["GET", "/settings/whatsapp", handleWhatsappSettingsGet],
  ["POST", "/settings/whatsapp", handleWhatsappSettingsPost],
  ["POST", "/settings/whatsapp/connect", handleWhatsappConnect],
  ["POST", "/settings/whatsapp/test", handleWhatsappTest],
  ["POST", "/settings/whatsapp/templates", handleWhatsappTemplates],
  ["POST", "/settings/whatsapp/send-test", handleWhatsappSendTest],
  ["POST", "/settings/whatsapp/qr/start", handleQrStart],
  ["GET", "/settings/whatsapp/qr/status", handleQrStatus],
  ["POST", "/settings/whatsapp/qr/logout", handleQrLogout],
  ["GET", "/settings/phone", handlePhoneSetupGet],
  ["POST", "/settings/phone/key", handlePhoneKeyPost],
  ["GET", "/settings/billing", handleBillingGet],
  ["POST", "/billing/create-subscription", handleCreateSubscription],
  ["GET", "/billing/status", handleBillingStatus],
  ["GET", "/settings/team", handleTeamGet],
  ["POST", "/settings/team", handleTeamPost],
];

/** Resolves one request, or null when nothing matches. */
export async function dispatch(ctx, deps) {
  const route = ROUTES.find(([method, path]) => method === ctx.method && path === ctx.pathname);
  if (!route) return null;
  return route[2](ctx, deps);
}
