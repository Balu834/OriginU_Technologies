/**
 * The gateway, tested with a fake WhatsApp socket and in-memory Redis.
 * No network, no Baileys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { createMemoryRedis } from "../lib/redis.mjs";
import { useRedisAuthState, clearAuthState, hasLinkedDevice } from "../lib/authState.mjs";
import { createSessionManager, phoneFromJid, isPersonalChat, textOf } from "../lib/sessions.mjs";
import { createGatewayHandler } from "../server.mjs";
import { createForwarder } from "../lib/forward.mjs";
import { signQrRequest, verifyQrRequest, QR_SIGNATURE_HEADER } from "../../lib/qrSigning.mjs";

const KEY = crypto.randomBytes(32).toString("hex");
const SECRET = "s".repeat(40);
const baileys = { initAuthCreds: () => ({ noiseKey: Buffer.from("noise"), registered: false }), proto: null };
const flush = () => new Promise((r) => setImmediate(r));

function fakeSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev,
    user: null,
    sent: [],
    presence: [],
    loggedOut: false,
    ended: false,
    onWhatsAppResult: undefined,
    async requestPairingCode(phone) { this.pairedFor = phone; return "ABCD1234"; },
    async sendMessage(jid, content) {
      const id = `MSG${this.sent.length + 1}`;
      this.sent.push({ jid, content, id });
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate(type, jid) { this.presence.push([type, jid]); },
    async onWhatsApp(jid) { return this.onWhatsAppResult ?? [{ jid, exists: true }]; },
    async logout() { this.loggedOut = true; },
    end() { this.ended = true; },
    emitConnection(update) { ev.emit("connection.update", update); },
  };
  return sock;
}

function setup(overrides = {}) {
  const redis = createMemoryRedis();
  const sockets = [];
  const forwarded = [];
  let reply = {};
  const manager = createSessionManager({
    redis,
    encryptionKey: KEY,
    baileys,
    instanceId: "machine-a",
    makeSocket: async ({ auth }) => {
      const s = fakeSocket();
      s.auth = auth;
      sockets.push(s);
      return s;
    },
    forward: async (event) => { forwarded.push(event); return reply; },
    qrToDataUrl: async (qr) => `data:image/png;base64,${Buffer.from(qr).toString("base64")}`,
    typingDelay: () => 0,
    sleep: async () => {},
    ...overrides,
  });
  return { redis, manager, sockets, forwarded, setReply: (r) => { reply = r; } };
}

async function connect(env, businessId = "biz1", phone = "919876543210") {
  await env.manager.start(businessId);
  const sock = env.sockets.at(-1);
  sock.auth.creds.me = { id: `${phone}:3@s.whatsapp.net` };
  sock.user = { id: `${phone}:3@s.whatsapp.net` };
  sock.ev.emit("creds.update", { me: sock.auth.creds.me }); // Baileys saves creds on link
  await flush();
  sock.emitConnection({ connection: "open" });
  await flush();
  return sock;
}

// ---------------------------------------------------------------- helpers

test("phoneFromJid reads personal-chat numbers and nothing else", () => {
  assert.equal(phoneFromJid("919876543210@s.whatsapp.net"), "919876543210");
  assert.equal(phoneFromJid("919876543210:12@s.whatsapp.net"), "919876543210");
  assert.equal(phoneFromJid("12036302@g.us"), null);
  assert.equal(phoneFromJid("123456@lid"), null);
});

test("groups, status, broadcasts and channels are not personal chats", () => {
  assert.equal(isPersonalChat("919876543210@s.whatsapp.net"), true);
  assert.equal(isPersonalChat("1234@lid"), true);
  assert.equal(isPersonalChat("12036302@g.us"), false);
  assert.equal(isPersonalChat("status@broadcast"), false);
  assert.equal(isPersonalChat("1234@newsletter"), false);
});

test("textOf unwraps disappearing messages and ignores media", () => {
  assert.equal(textOf({ conversation: "hi" }), "hi");
  assert.equal(textOf({ extendedTextMessage: { text: "fan broken" } }), "fan broken");
  assert.equal(textOf({ ephemeralMessage: { message: { conversation: "inside" } } }), "inside");
  assert.equal(textOf({ imageMessage: { caption: "x" } }), null);
});

// ---------------------------------------------------------------- storage

test("session keys are encrypted at rest and survive a round trip", async () => {
  const redis = createMemoryRedis();
  const { state, saveCreds } = await useRedisAuthState(redis, "biz1", KEY, baileys);
  state.creds.me = { id: "919876543210@s.whatsapp.net", name: "Ravi Electricals" };
  await saveCreds();
  await state.keys.set({ session: { "919876543210.0": Buffer.from("secret-signal-session") } });

  for (const value of redis.strings.values()) {
    assert.doesNotMatch(value, /Ravi Electricals|secret-signal-session|919876543210/);
  }

  const again = await useRedisAuthState(redis, "biz1", KEY, baileys);
  assert.equal(again.state.creds.me.name, "Ravi Electricals");
  const got = await again.state.keys.get("session", ["919876543210.0", "missing"]);
  assert.equal(Buffer.from(got["919876543210.0"]).toString(), "secret-signal-session");
  assert.equal("missing" in got, false);
  assert.equal(await hasLinkedDevice(redis, "biz1", KEY), true);
});

test("a key set to null is deleted, and clearAuthState removes everything", async () => {
  const redis = createMemoryRedis();
  const { state, saveCreds } = await useRedisAuthState(redis, "biz1", KEY, baileys);
  await saveCreds();
  await state.keys.set({ "pre-key": { 1: { a: Buffer.from("x") }, 2: { b: Buffer.from("y") } } });
  await state.keys.set({ "pre-key": { 1: null } });
  assert.deepEqual(Object.keys(await state.keys.get("pre-key", ["1", "2"])), ["2"]);

  await clearAuthState(redis, "biz1");
  assert.equal(redis.strings.size, 0);
  assert.equal(await hasLinkedDevice(redis, "biz1", KEY), false);
});

test("a different encryption key cannot read the session", async () => {
  const redis = createMemoryRedis();
  const { saveCreds } = await useRedisAuthState(redis, "biz1", KEY, baileys);
  await saveCreds();
  await assert.rejects(() => useRedisAuthState(redis, "biz1", crypto.randomBytes(32).toString("hex"), baileys));
});

// ---------------------------------------------------------------- sessions

test("start shows a QR; scanning it reports the connected number to the app", async () => {
  const env = setup();
  await env.manager.start("biz1");
  env.sockets[0].emitConnection({ qr: "QR-STRING-1" });
  await flush();
  const shown = await env.manager.status("biz1");
  assert.equal(shown.state, "qr");
  assert.match(shown.qrDataUrl, /^data:image\/png;base64,/);

  await connect(env);
  const status = await env.manager.status("biz1");
  assert.equal(status.state, "connected");
  assert.equal(status.phone, "+919876543210");
  assert.equal(status.qrDataUrl, undefined);
  assert.deepEqual(env.forwarded.at(-1), { businessId: "biz1", type: "connection", state: "connected", phone: "+919876543210" });
});

test("code mode asks WhatsApp for a pairing code for the typed number", async () => {
  const env = setup();
  const result = await env.manager.start("biz1", { mode: "code", phone: "+91 98765 43210" });
  assert.equal(result.ok, true);
  env.sockets[0].emitConnection({ qr: "ignored-qr" });
  await flush();
  const status = await env.manager.status("biz1");
  assert.equal(status.state, "code");
  assert.equal(status.pairingCode, "ABCD1234");
  assert.equal(env.sockets[0].pairedFor, "919876543210");
});

test("code mode refuses a number that isn't one", async () => {
  const env = setup();
  assert.deepEqual(await env.manager.start("biz1", { mode: "code", phone: "abc" }), { ok: false, code: "bad_phone" });
});

test("only one machine may hold a business's session", async () => {
  const env = setup();
  await env.redis.command("SET", "waqr:lock:biz1", "machine-b", "EX", "60");
  const result = await env.manager.start("biz1");
  assert.deepEqual(result, { ok: false, code: "elsewhere", owner: "machine-b" });
  assert.equal(env.sockets.length, 0);
  assert.equal(await env.manager.ownerOf("biz1"), "machine-b");
});

test("logged out from the phone: session is deleted and the app is told", async () => {
  const env = setup();
  const sock = await connect(env);
  await sock.auth.keys.set({ session: { a: Buffer.from("k") } });
  sock.emitConnection({ connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await flush(); await flush();

  assert.equal(env.forwarded.at(-1).state, "logged_out");
  assert.equal(await hasLinkedDevice(env.redis, "biz1", KEY), false);
  assert.equal(env.redis.strings.has("waqr:lock:biz1"), false);
  assert.deepEqual(await env.redis.command("SMEMBERS", "waqr:index"), []);
});

test("blocked by WhatsApp (403) is reported as banned", async () => {
  const env = setup();
  const sock = await connect(env);
  sock.emitConnection({ connection: "close", lastDisconnect: { error: { output: { statusCode: 403 } } } });
  await flush(); await flush();
  assert.equal(env.forwarded.at(-1).state, "banned");
});

test("an unscanned QR that runs out ends as expired, without reconnect loops", async () => {
  const env = setup();
  await env.manager.start("biz1");
  env.sockets[0].emitConnection({ connection: "close", lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await flush();
  assert.equal((await env.manager.status("biz1")).state, "expired");
  assert.equal(env.sockets.length, 1);
});

test("the restart WhatsApp asks for right after linking reconnects", async () => {
  const env = setup();
  const sock = await connect(env);
  sock.emitConnection({ connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(env.sockets.length, 2);
});

// ---------------------------------------------------------------- messages

function upsert(sock, messages, type = "notify") {
  sock.ev.emit("messages.upsert", { messages, type });
  return flush();
}

test("a customer's text is forwarded; groups, status and history are not", async () => {
  const env = setup();
  const sock = await connect(env);
  env.forwarded.length = 0;

  await upsert(sock, [
    { key: { id: "A1", remoteJid: "917000000001@s.whatsapp.net" }, message: { conversation: "AC not cooling" }, messageTimestamp: 1700000000 },
    { key: { id: "G1", remoteJid: "12036302@g.us", participant: "917000000002@s.whatsapp.net" }, message: { conversation: "group chat" } },
    { key: { id: "S1", remoteJid: "status@broadcast" }, message: { conversation: "status" } },
  ]);
  await upsert(sock, [{ key: { id: "H1", remoteJid: "917000000003@s.whatsapp.net" }, message: { conversation: "old" } }], "append");

  assert.deepEqual(env.forwarded, [{
    businessId: "biz1", type: "message", from: "+917000000001", messageId: "A1",
    messageType: "text", text: "AC not cooling", timestamp: 1700000000,
  }]);
});

test("media is forwarded as 'other' with no content", async () => {
  const env = setup();
  const sock = await connect(env);
  env.forwarded.length = 0;
  await upsert(sock, [{ key: { id: "I1", remoteJid: "917000000001@s.whatsapp.net" }, message: { imageMessage: { caption: "private photo" } } }]);
  assert.equal(env.forwarded[0].messageType, "other");
  assert.equal(env.forwarded[0].text, "");
});

test("a sender known only by LID is mapped to their number", async () => {
  const env = setup();
  const sock = await connect(env);
  sock.signalRepository = { lidMapping: { getPNForLID: async () => "917000000009@s.whatsapp.net" } };
  env.forwarded.length = 0;
  await upsert(sock, [{ key: { id: "L1", remoteJid: "55555@lid" }, message: { conversation: "hello" } }]);
  assert.equal(env.forwarded[0].from, "+917000000009");
});

test("the owner typing from their phone is an owner_reply; our own sends are not", async () => {
  const env = setup();
  const sock = await connect(env);
  const sent = await env.manager.send("biz1", { to: "+917000000001", text: "Hi from the bot" });
  env.forwarded.length = 0;

  await upsert(sock, [
    { key: { id: sent.id, remoteJid: "917000000001@s.whatsapp.net", fromMe: true }, message: { conversation: "Hi from the bot" } },
    { key: { id: "OWN1", remoteJid: "917000000001@s.whatsapp.net", fromMe: true }, message: { conversation: "I'll come at 5" } },
    { key: { id: "SELF", remoteJid: "919876543210@s.whatsapp.net", fromMe: true }, message: { conversation: "note to self" } },
  ]);
  assert.deepEqual(env.forwarded, [{ businessId: "biz1", type: "owner_reply", to: "+917000000001", messageId: "OWN1" }]);
});

test("delivery receipts are forwarded only for messages we sent", async () => {
  const env = setup();
  const sock = await connect(env);
  const sent = await env.manager.send("biz1", { to: "+917000000001", text: "hello" });
  env.forwarded.length = 0;
  sock.ev.emit("messages.update", [
    { key: { id: sent.id, fromMe: true }, update: { status: 3 } },
    { key: { id: "SOMEONE_ELSES", fromMe: true }, update: { status: 4 } },
  ]);
  await flush();
  assert.deepEqual(env.forwarded, [{ businessId: "biz1", type: "receipt", messageId: sent.id, status: "delivered" }]);
});

test("the app answering stop logs the session out", async () => {
  const env = setup();
  const sock = await connect(env);
  env.setReply({ stop: true, reason: "not_qr" });
  await upsert(sock, [{ key: { id: "A1", remoteJid: "917000000001@s.whatsapp.net" }, message: { conversation: "hi" } }]);
  await flush();
  assert.equal(sock.loggedOut, true);
  assert.equal((await env.manager.status("biz1")).state, "idle");
});

// ---------------------------------------------------------------- sending

test("send types first, then sends, and returns the message id", async () => {
  const env = setup();
  const sock = await connect(env);
  const result = await env.manager.send("biz1", { to: "+91 70000 00001", text: "Sorry we missed your call" });
  assert.deepEqual(result, { ok: true, id: "MSG1" });
  assert.deepEqual(sock.presence.map((p) => p[0]), ["composing", "paused"]);
  assert.equal(sock.sent[0].jid, "917000000001@s.whatsapp.net");
});

test("send refuses when not connected, for non-WhatsApp numbers, and over the hourly cap", async () => {
  const env = setup({ maxSendsPerHour: 1 });
  assert.equal((await env.manager.send("biz1", { to: "+917000000001", text: "x" })).code, "not_connected");
  const sock = await connect(env);
  sock.onWhatsAppResult = [];
  assert.equal((await env.manager.send("biz1", { to: "+917000000001", text: "x" })).code, "not_on_whatsapp");
  sock.onWhatsAppResult = undefined;
  assert.equal((await env.manager.send("biz1", { to: "+917000000001", text: "x" })).ok, true);
  assert.equal((await env.manager.send("biz1", { to: "+917000000002", text: "y" })).code, "rate_limited");
});

test("logout unlinks the device and deletes the stored session", async () => {
  const env = setup();
  const sock = await connect(env);
  await env.manager.logout("biz1");
  assert.equal(sock.loggedOut, true);
  assert.equal(await hasLinkedDevice(env.redis, "biz1", KEY), false);
  assert.equal(env.manager.size, 0);
});

test("restoreAll reopens linked businesses and forgets unlinked ones", async () => {
  const env = setup();
  await connect(env, "biz1");
  await env.manager.shutdown();
  await env.redis.command("SADD", "waqr:index", "ghost");

  // A new process (same machine id) reading the same Redis.
  const restoredManager = createSessionManager({
    redis: env.redis, encryptionKey: KEY, baileys, instanceId: "machine-a",
    makeSocket: async ({ auth }) => { const s = fakeSocket(); s.auth = auth; env.sockets.push(s); return s; },
    forward: async () => ({}), typingDelay: () => 0, sleep: async () => {},
  });
  assert.equal(await restoredManager.restoreAll({ gapMs: 0 }), 1);
  assert.deepEqual(await env.redis.command("SMEMBERS", "waqr:index"), ["biz1"]);
});

// ---------------------------------------------------------------- HTTP + signing

function signedRequest(route, payload, secret = SECRET) {
  const raw = Buffer.from(JSON.stringify({ requestId: crypto.randomUUID(), ...payload }));
  return { method: "POST", path: route, rawBody: raw, headers: { [QR_SIGNATURE_HEADER]: signQrRequest(raw, secret) } };
}

test("signatures: a tampered, unsigned or stale request is refused", () => {
  const body = Buffer.from('{"a":1}');
  const header = signQrRequest(body, SECRET);
  assert.equal(verifyQrRequest(body, header, SECRET), true);
  assert.equal(verifyQrRequest(Buffer.from('{"a":2}'), header, SECRET), false);
  assert.equal(verifyQrRequest(body, header, "x".repeat(40)), false);
  assert.equal(verifyQrRequest(body, undefined, SECRET), false);
  const old = signQrRequest(body, SECRET, Date.now() - 10 * 60 * 1000);
  assert.equal(verifyQrRequest(body, old, SECRET), false);
});

test("the HTTP API refuses unsigned and replayed requests", async () => {
  const env = setup();
  const handle = createGatewayHandler({ manager: env.manager, secret: SECRET });

  const unsigned = await handle({ method: "POST", path: "/sessions/start", rawBody: Buffer.from('{"businessId":"biz1","requestId":"abcdefgh1"}'), headers: {} });
  assert.equal(unsigned.status, 401);

  const req = signedRequest("/sessions/start", { businessId: "biz1" });
  assert.equal((await handle(req)).status, 200);
  assert.equal((await handle(req)).status, 409);
  assert.equal(env.sockets.length, 1);
});

test("the HTTP API sends, reports status and logs out", async () => {
  const env = setup();
  const handle = createGatewayHandler({ manager: env.manager, secret: SECRET });
  await connect(env);

  const status = await handle(signedRequest("/sessions/status", { businessId: "biz1" }));
  assert.equal(status.body.status.state, "connected");

  const sent = await handle(signedRequest("/sessions/send", { businessId: "biz1", to: "+917000000001", text: "hello" }));
  assert.equal(sent.status, 200);
  assert.equal(sent.body.id, "MSG1");

  const out = await handle(signedRequest("/sessions/logout", { businessId: "biz1" }));
  assert.equal(out.status, 200);
  assert.equal((await handle(signedRequest("/sessions/status", { businessId: "biz1" }))).body.status.state, "idle");
});

test("on Fly, a session held by another machine is replayed there", async () => {
  const env = setup();
  await env.redis.command("SET", "waqr:lock:biz1", "machine-b", "EX", "60");
  const handle = createGatewayHandler({ manager: env.manager, secret: SECRET, onFly: true });
  const result = await handle(signedRequest("/sessions/send", { businessId: "biz1", to: "+917000000001", text: "x" }));
  assert.equal(result.headers["fly-replay"], "instance=machine-b");
});

test("health shows counts only", async () => {
  const env = setup();
  await connect(env);
  const handle = createGatewayHandler({ manager: env.manager, secret: SECRET });
  const health = await handle({ method: "GET", path: "/health" });
  assert.equal(health.body.sessions, 1);
  assert.equal(health.body.connected, 1);
  assert.equal(JSON.stringify(health.body).includes("biz1"), false);
});

test("the forwarder signs events and retries a server error", async () => {
  const calls = [];
  const forward = createForwarder({
    appUrl: "https://app.example/",
    secret: SECRET,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.deepEqual(await forward({ type: "message" }), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://app.example/qr/events");
  assert.equal(verifyQrRequest(calls[1].init.body, calls[1].init.headers[QR_SIGNATURE_HEADER], SECRET), true);
});
