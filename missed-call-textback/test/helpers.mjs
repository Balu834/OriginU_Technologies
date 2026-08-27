import crypto from "node:crypto";
import { createStore } from "../lib/store.mjs";
import templates from "../templates.json" with { type: "json" };

export const TEST_CONFIG = {
  META_ACCESS_TOKEN: "test-access-token",
  META_PHONE_NUMBER_ID: "1234567890",
  META_WABA_ID: "waba-id",
  META_VERIFY_TOKEN: "verify-me",
  META_APP_SECRET: "test-app-secret",
  MOHAMED_WHATSAPP_NUMBER: "+919110819125",
  WEBHOOK_BASE_URL: "https://example.com",
  MISSED_CALL_API_KEY: "test-missed-call-key",
  WHATSAPP_MISSED_CALL_TEMPLATE: "missed_call_immediate",
  WHATSAPP_TEMPLATE_LANGUAGE: "en",
  BUSINESS_NAME: "Planet Electrical",
  OWNER_NAME: "Mohamed",
  PORT: 0,
  DATA_DIR: "",
  DEMO_MODE: false,
};

/** Records every outbound message instead of hitting the network. */
export function createFakeWa() {
  const sent = [];
  return {
    sent,
    sendTemplate(to, templateName, languageCode, bodyParams = []) {
      sent.push({ kind: "template", to, templateName, languageCode, bodyParams });
      return Promise.resolve({ ok: true, status: 200, body: {} });
    },
    sendText(to, body) {
      sent.push({ kind: "text", to, body });
      return Promise.resolve({ ok: true, status: 200, body: {} });
    },
  };
}

export function createTestDeps(overrides = {}) {
  const config = { ...TEST_CONFIG, ...overrides };
  const store = createStore(null);
  const wa = createFakeWa();
  return { config, store, wa, templates };
}

export function signBody(rawBody, appSecret = TEST_CONFIG.META_APP_SECRET) {
  return "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

export function jsonCtx({ method, pathname, query = {}, headers = {}, body }) {
  const rawBody = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method,
    pathname,
    query: new URLSearchParams(query),
    headers,
    rawBody,
    json: body ?? {},
  };
}
