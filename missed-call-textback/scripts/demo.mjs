/**
 * [DEMO / SIMULATED] Walks the full missed-call -> WhatsApp -> conversation
 * -> lead -> owner-notification flow locally, without calling Meta's API
 * and without needing real credentials. Every outbound "WhatsApp message"
 * is just printed to the console, clearly labelled.
 *
 * This does NOT bypass any Meta restriction in production — it's a local
 * rehearsal tool only. Run it with: npm run demo
 */
import { createStore } from "../lib/store.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import templates from "../templates.json" with { type: "json" };

const config = {
  BUSINESS_NAME: "Planet Electrical",
  OWNER_NAME: "Mohamed",
  MOHAMED_WHATSAPP_NUMBER: "+919110819125",
  WHATSAPP_MISSED_CALL_TEMPLATE: "missed_call_immediate",
  WHATSAPP_TEMPLATE_LANGUAGE: "en",
};

const CALLER = "+919876543210";

function say(who, text) {
  console.log(`\n[${who}] ${text}`);
}

async function main() {
  console.log("=== [DEMO / SIMULATED] Missed-call textback walkthrough ===");
  console.log("No real WhatsApp messages are sent — this is a local rehearsal only.\n");

  const store = createStore(null);
  const wa = {
    sendTemplate(to, name) {
      say("SYSTEM -> customer", `(template "${name}") Sorry we missed your call — this is ${config.BUSINESS_NAME}. Reply here with what you need and your area, and ${config.OWNER_NAME} will call you straight back.`);
      return Promise.resolve({ ok: true });
    },
    sendText(to, body) {
      const who = to === config.MOHAMED_WHATSAPP_NUMBER ? "SYSTEM -> Mohamed" : "SYSTEM -> customer";
      say(who, body);
      return Promise.resolve({ ok: true });
    },
  };

  console.log(`--- Step 1: Mohamed misses a call from ${CALLER} ---`);
  await wa.sendTemplate(CALLER, config.WHATSAPP_MISSED_CALL_TEMPLATE);

  console.log("\n--- Step 2: customer replies over a few messages ---");
  const turns = ["AC not cooling", "Whitefield", "Ravi", "Need someone today"];
  for (const text of turns) {
    say("customer", text);
    await handleInboundMessage({ from: CALLER, text }, { store, wa, config, templates });
  }

  console.log("\n--- Step 3: emergency variant (separate customer) ---");
  const emergencyCaller = "+919876500000";
  say("customer", "There is smoke coming from the switch");
  await handleInboundMessage({ from: emergencyCaller, text: "There is smoke coming from the switch" }, { store, wa, config, templates });

  console.log("\n=== Lead(s) captured ===");
  console.log(JSON.stringify(store.listLeads(), null, 2));
  console.log("\n=== End of simulated demo ===");
}

main();
