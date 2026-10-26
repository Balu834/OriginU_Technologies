/**
 * Live smoke test: opens one real Baileys session against WhatsApp with
 * in-memory storage and waits for a QR. Links nothing (nobody scans it),
 * sends nothing, stores nothing. Run from qr-gateway/:
 *
 *   node scripts/smoke-qr.mjs
 */
import crypto from "node:crypto";
import makeWASocket, { Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds, proto } from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { createMemoryRedis } from "../lib/redis.mjs";
import { createSessionManager } from "../lib/sessions.mjs";

const logger = pino({ level: "silent" });
const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

const manager = createSessionManager({
  redis: createMemoryRedis(),
  encryptionKey: crypto.randomBytes(32).toString("hex"),
  baileys: { initAuthCreds, proto },
  instanceId: "smoke",
  forward: async () => ({}),
  qrToDataUrl: (qr) => QRCode.toDataURL(qr, { margin: 1, width: 280 }),
  makeSocket: ({ auth }) => makeWASocket({
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
    version, logger, browser: Browsers.ubuntu("Chrome"), printQRInTerminal: false,
    markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
  }),
});

await manager.start("smoke-test");
const deadline = Date.now() + 45_000;
let status;
while (Date.now() < deadline) {
  status = await manager.status("smoke-test");
  if (status.state === "qr") break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(JSON.stringify({
  state: status.state,
  qrIsPng: String(status.qrDataUrl ?? "").startsWith("data:image/png;base64,"),
  qrBytes: status.qrDataUrl?.length ?? 0,
  rssMb: Math.round(process.memoryUsage().rss / 1048576),
}));
await manager.shutdown();
process.exit(status.state === "qr" ? 0 : 1);
