/**
 * One live WhatsApp linked-device session per business.
 *
 * UNOFFICIAL. This logs in as a "linked device" on the business owner's
 * own WhatsApp, the way WhatsApp Web does. It is against WhatsApp's terms
 * and the number can be banned. The app only offers it after the owner
 * has read and accepted that.
 *
 * What this module promises:
 *
 * - One process holds a business's session at a time. Two sockets on the
 *   same login knock each other off, so a Redis lock (with this machine's
 *   id as its value) decides who owns it.
 * - It never decides who gets a reply. It forwards personal-chat text to
 *   the app, which only answers people who missed-called the business.
 *   Groups, status updates, broadcasts and channels are dropped here.
 * - It keeps nothing about messages beyond the ids of what it sent (to
 *   tell its own echoes apart and to match delivery receipts).
 * - A logout or ban deletes the stored session, so a dead login is not
 *   kept around holding someone's keys.
 *
 * Everything that touches WhatsApp (makeSocket, the Baileys helpers) is
 * injected, so this file is tested with a fake socket.
 */
import { useRedisAuthState, clearAuthState, hasLinkedDevice } from "./authState.mjs";

const LOCK_TTL_SECONDS = 60;
const INDEX_KEY = "waqr:index";
const lockKey = (businessId) => `waqr:lock:${businessId}`;

// Disconnect codes (Baileys DisconnectReason).
const LOGGED_OUT = 401;
const FORBIDDEN = 403;
const REPLACED = 440;
const RESTART_REQUIRED = 515;
const MAX_RECONNECT_ATTEMPTS = 8;

const RECEIPT_STATUS = { 0: "failed", 2: "sent", 3: "delivered", 4: "read", 5: "read" };

/** Digits of the phone number in a personal-chat jid ("919876543210:12@s.whatsapp.net"). */
export function phoneFromJid(jid) {
  const m = /^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(jid ?? ""));
  return m ? m[1] : null;
}

/** Only one-to-one chats. Groups, status, broadcast lists and channels never reach the app. */
export function isPersonalChat(jid) {
  const j = String(jid ?? "");
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@lid");
}

/** The text of a message, or null for anything that is not text. */
export function textOf(message) {
  let m = message;
  // Disappearing-message and view-once wrappers hold the real content inside.
  for (let i = 0; i < 3 && m; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message;
    if (!inner) break;
    m = inner;
  }
  const text = m?.conversation ?? m?.extendedTextMessage?.text ?? null;
  return typeof text === "string" ? text : null;
}

const defaultTypingDelay = (text) => 1200 + Math.min(3000, String(text).length * 25);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSessionManager({
  redis,
  encryptionKey,
  baileys,
  makeSocket,
  forward,
  instanceId,
  qrToDataUrl = async () => null,
  log = () => {},
  maxSendsPerHour = 60,
  typingDelay = defaultTypingDelay,
  sleep = defaultSleep,
  now = () => Date.now(),
}) {
  const sessions = new Map();
  const queues = new Map();

  /** Runs start/logout for one business one at a time, so two clicks can't open two sockets. */
  function serial(businessId, fn) {
    const prev = queues.get(businessId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(businessId, next.catch(() => {}));
    return next;
  }

  // ------------------------------------------------------------ lock

  /** true when this instance holds (or just took) the lock, else the other owner's id. */
  async function acquireLock(businessId) {
    const key = lockKey(businessId);
    const set = await redis.command("SET", key, instanceId, "NX", "EX", String(LOCK_TTL_SECONDS));
    if (set === "OK") return true;
    const owner = await redis.command("GET", key);
    if (owner === instanceId) {
      await redis.command("EXPIRE", key, String(LOCK_TTL_SECONDS));
      return true;
    }
    if (owner === null) return acquireLock(businessId); // expired in between
    return owner;
  }

  async function releaseLock(businessId) {
    const key = lockKey(businessId);
    if ((await redis.command("GET", key)) === instanceId) await redis.command("DEL", key);
  }

  /** Who holds a business's session: "self", another instance's id, or null. */
  async function ownerOf(businessId) {
    if (sessions.has(businessId)) return "self";
    const owner = await redis.command("GET", lockKey(businessId));
    return owner === instanceId ? "self" : owner;
  }

  // ------------------------------------------------------------ helpers

  function record(businessId) {
    return {
      businessId,
      sock: null,
      creds: null,
      state: "starting",
      qr: null,
      pairingPhone: null,
      pairingCode: null,
      phone: null,
      since: now(),
      lastError: null,
      attempts: 0,
      stopping: false,
      reconnectTimer: null,
      sentIds: new Map(),
      sendTimes: [],
    };
  }

  const linked = (s) => Boolean(s.creds?.me?.id || s.creds?.registered);

  function rememberSent(s, id) {
    if (!id) return;
    s.sentIds.set(id, now());
    if (s.sentIds.size > 5000) s.sentIds.delete(s.sentIds.keys().next().value);
  }

  async function tell(s, event) {
    try {
      const reply = await forward({ businessId: s.businessId, ...event });
      if (reply?.stop) {
        log("qr_session_stopped_by_app", { businessId: s.businessId, reason: reply.reason ?? null });
        await logout(s.businessId);
      }
      return reply;
    } catch (err) {
      log("qr_forward_failed", { businessId: s.businessId, type: event.type, error: err.message });
      return null;
    }
  }

  function endSocket(s) {
    clearTimeout(s.reconnectTimer);
    const sock = s.sock;
    s.sock = null;
    try { sock?.end?.(undefined); } catch { /* already closed */ }
  }

  /** The session is over for good (logged out or blocked): delete it everywhere. */
  async function finish(s, outcome) {
    s.stopping = true;
    endSocket(s);
    s.state = outcome;
    s.since = now();
    await clearAuthState(redis, s.businessId);
    await redis.command("SREM", INDEX_KEY, s.businessId);
    await releaseLock(s.businessId);
    log("qr_session_finished", { businessId: s.businessId, outcome });
    await tell(s, { type: "connection", state: outcome });
  }

  async function phoneOf(sock, key) {
    for (const jid of [key.remoteJid, key.remoteJidAlt, key.senderPn]) {
      const phone = phoneFromJid(jid);
      if (phone) return phone;
    }
    const lid = [key.remoteJid, key.remoteJidAlt].find((j) => String(j ?? "").endsWith("@lid"));
    if (lid) {
      try {
        return phoneFromJid(await sock.signalRepository?.lidMapping?.getPNForLID?.(lid));
      } catch {
        return null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ socket events

  async function onConnection(s, sock, update) {
    if (s.sock !== sock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (s.pairingPhone && !linked(s)) {
        if (!s.pairingCode) {
          try {
            s.pairingCode = await sock.requestPairingCode(s.pairingPhone);
            s.state = "code";
          } catch (err) {
            s.state = "failed";
            s.lastError = "pairing_code_failed";
            log("qr_pairing_code_failed", { businessId: s.businessId, error: err.message });
          }
          s.since = now();
        }
      } else {
        s.qr = qr;
        s.state = "qr";
        s.since = now();
      }
    }

    if (connection === "open") {
      s.state = "connected";
      s.qr = null;
      s.pairingCode = null;
      s.attempts = 0;
      s.lastError = null;
      s.since = now();
      s.phone = phoneFromJid(sock.user?.id) ?? s.phone;
      log("qr_session_open", { businessId: s.businessId });
      await tell(s, { type: "connection", state: "connected", phone: s.phone ? `+${s.phone}` : null });
      return;
    }

    if (connection === "close") {
      if (s.stopping) return;
      const code = lastDisconnect?.error?.output?.statusCode ?? null;
      s.sock = null;
      log("qr_session_closed", { businessId: s.businessId, code });

      if (code === LOGGED_OUT) return finish(s, "logged_out");
      if (code === FORBIDDEN) return finish(s, "banned");
      if (code === REPLACED) {
        // Another process or device took this login. Don't fight it.
        s.state = "replaced";
        s.since = now();
        await releaseLock(s.businessId);
        sessions.delete(s.businessId);
        await tell(s, { type: "connection", state: "replaced" });
        return;
      }
      if (!linked(s) && code !== RESTART_REQUIRED) {
        // The QR or code was never used and has run out. Start over on request.
        s.state = "expired";
        s.qr = null;
        s.pairingCode = null;
        s.since = now();
        await clearAuthState(redis, s.businessId);
        await redis.command("SREM", INDEX_KEY, s.businessId);
        return;
      }

      s.attempts += 1;
      if (s.attempts > MAX_RECONNECT_ATTEMPTS) {
        s.state = "failed";
        s.lastError = `disconnected_${code ?? "unknown"}`;
        s.since = now();
        await tell(s, { type: "connection", state: "failed" });
        return;
      }
      s.state = "reconnecting";
      const delay = code === RESTART_REQUIRED ? 0 : Math.min(60_000, 1000 * 2 ** s.attempts);
      s.reconnectTimer = setTimeout(() => {
        if (!s.stopping && sessions.get(s.businessId) === s) {
          openSocket(s).catch((err) => log("qr_reconnect_failed", { businessId: s.businessId, error: err.message }));
        }
      }, delay);
    }
  }

  async function onUpsert(s, sock, { messages = [], type } = {}) {
    if (s.sock !== sock || type !== "notify") return;
    for (const m of messages) {
      const key = m?.key ?? {};
      if (!isPersonalChat(key.remoteJid)) continue;
      if (key.fromMe && s.sentIds.has(key.id)) continue; // our own send, echoed back

      const phone = await phoneOf(sock, key);
      if (!phone) {
        log("qr_unmapped_sender", { businessId: s.businessId });
        continue;
      }
      if (phone === s.phone) continue; // the owner's "message yourself" chat

      if (key.fromMe) {
        // The owner typed to this person from their phone: they're handling it.
        await tell(s, { type: "owner_reply", to: `+${phone}`, messageId: key.id ?? null });
        continue;
      }

      const text = textOf(m.message);
      await tell(s, {
        type: "message",
        from: `+${phone}`,
        messageId: key.id ?? null,
        messageType: text === null ? "other" : "text",
        text: text ?? "",
        timestamp: Number(m.messageTimestamp) || null,
      });
    }
  }

  async function onUpdate(s, updates = []) {
    for (const u of updates) {
      const id = u?.key?.id;
      if (!u?.key?.fromMe || !s.sentIds.has(id)) continue;
      const status = RECEIPT_STATUS[u.update?.status];
      if (status) await tell(s, { type: "receipt", messageId: id, status });
    }
  }

  async function openSocket(s) {
    const { state, saveCreds } = await useRedisAuthState(redis, s.businessId, encryptionKey, baileys);
    s.creds = state.creds;
    const sock = await makeSocket({ auth: state, businessId: s.businessId });
    s.sock = sock;
    s.stopping = false;
    const guard = (fn) => (arg) => Promise.resolve(fn(arg)).catch((err) =>
      log("qr_event_error", { businessId: s.businessId, error: err.message }));
    sock.ev.on("creds.update", guard(() => saveCreds()));
    sock.ev.on("connection.update", guard((u) => onConnection(s, sock, u)));
    sock.ev.on("messages.upsert", guard((u) => onUpsert(s, sock, u)));
    sock.ev.on("messages.update", guard((u) => onUpdate(s, u)));
  }

  // ------------------------------------------------------------ public API

  function statusOf(s) {
    return {
      state: s.state,
      phone: s.phone ? `+${s.phone}` : null,
      pairingCode: s.state === "code" ? s.pairingCode : null,
      since: new Date(s.since).toISOString(),
      lastError: s.lastError,
    };
  }

  /**
   * Opens (or reopens) a business's session.
   * mode "qr": show a QR. mode "code": give an 8-character code for `phone`.
   * A business that already has a linked device just reconnects, no QR.
   */
  function start(businessId, { mode = "qr", phone = "" } = {}) {
    return serial(businessId, async () => {
      const pairingPhone = mode === "code" ? String(phone).replace(/\D/g, "") : null;
      if (mode === "code" && !/^\d{8,15}$/.test(pairingPhone)) return { ok: false, code: "bad_phone" };

      const lock = await acquireLock(businessId);
      if (lock !== true) return { ok: false, code: "elsewhere", owner: lock };

      const existing = sessions.get(businessId);
      if (existing?.state === "connected" && existing.sock) return { ok: true, status: statusOf(existing) };
      if (existing) {
        existing.stopping = true;
        endSocket(existing);
      }

      const s = record(businessId);
      s.pairingPhone = pairingPhone;
      sessions.set(businessId, s);
      await redis.command("SADD", INDEX_KEY, businessId);
      await openSocket(s);
      return { ok: true, status: statusOf(s) };
    });
  }

  async function status(businessId) {
    const s = sessions.get(businessId);
    if (!s) {
      const stored = await hasLinkedDevice(redis, businessId, encryptionKey).catch(() => false);
      return { state: stored ? "offline" : "idle", phone: null, pairingCode: null, since: null, lastError: null };
    }
    const out = statusOf(s);
    if (s.state === "qr" && s.qr) out.qrDataUrl = await qrToDataUrl(s.qr);
    return out;
  }

  async function send(businessId, { to, text } = {}) {
    const s = sessions.get(businessId);
    if (!s || s.state !== "connected" || !s.sock) return { ok: false, code: "not_connected" };
    const digits = String(to ?? "").replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(digits)) return { ok: false, code: "bad_number" };
    const body = String(text ?? "");
    if (!body.trim() || body.length > 4096) return { ok: false, code: "bad_text" };

    const hourAgo = now() - 60 * 60 * 1000;
    s.sendTimes = s.sendTimes.filter((t) => t > hourAgo);
    if (s.sendTimes.length >= maxSendsPerHour) return { ok: false, code: "rate_limited" };

    let jid = `${digits}@s.whatsapp.net`;
    try {
      const found = await s.sock.onWhatsApp?.(jid);
      if (Array.isArray(found)) {
        if (!found.length || found[0]?.exists === false) return { ok: false, code: "not_on_whatsapp" };
        if (found[0]?.jid) jid = found[0].jid;
      }
    } catch {
      // The lookup is a courtesy; a failure here should not block the send.
    }

    try {
      // A person types before they send. Instant replies are a bot tell.
      try { await s.sock.sendPresenceUpdate?.("composing", jid); } catch { /* best effort */ }
      await sleep(typingDelay(body));
      try { await s.sock.sendPresenceUpdate?.("paused", jid); } catch { /* best effort */ }

      if (!s.sock) return { ok: false, code: "not_connected" };
      const sent = await s.sock.sendMessage(jid, { text: body });
      const id = sent?.key?.id ?? null;
      rememberSent(s, id);
      s.sendTimes.push(now());
      return { ok: true, id };
    } catch (err) {
      log("qr_send_failed", { businessId, error: err.message });
      return { ok: false, code: "send_failed" };
    }
  }

  /** Unlinks the device from the owner's WhatsApp and deletes everything stored for it. */
  function logout(businessId) {
    return serial(businessId, async () => {
      const s = sessions.get(businessId);
      if (s) {
        s.stopping = true;
        try { await s.sock?.logout?.(); } catch { /* may already be gone */ }
        endSocket(s);
        sessions.delete(businessId);
      }
      await clearAuthState(redis, businessId);
      await redis.command("SREM", INDEX_KEY, businessId);
      await releaseLock(businessId);
      log("qr_session_logged_out", { businessId });
      return { ok: true };
    });
  }

  /** Reopens every business that had a linked device, a few seconds apart. */
  async function restoreAll({ gapMs = 1500 } = {}) {
    const ids = (await redis.command("SMEMBERS", INDEX_KEY)) ?? [];
    let restored = 0;
    for (const id of ids) {
      if (!(await hasLinkedDevice(redis, id, encryptionKey).catch(() => false))) {
        await redis.command("SREM", INDEX_KEY, id);
        continue;
      }
      const result = await start(id, { mode: "restore" });
      if (result.ok) restored++;
      if (gapMs) await sleep(gapMs);
    }
    return restored;
  }

  /** Keeps this instance's locks alive; drops any session another instance has taken. */
  async function renewLocks() {
    // Only sessions that are live or about to be. An expired QR or a
    // failed login holds nothing worth keeping another machine away from.
    const ids = [...sessions.entries()]
      .filter(([, s]) => s.sock || s.state === "reconnecting")
      .map(([id]) => id);
    if (!ids.length) return;
    const owners = await redis.pipeline(ids.map((id) => ["GET", lockKey(id)]));
    const commands = [];
    ids.forEach((id, i) => {
      if (owners[i] === instanceId) commands.push(["EXPIRE", lockKey(id), String(LOCK_TTL_SECONDS)]);
      else if (owners[i] === null) commands.push(["SET", lockKey(id), instanceId, "NX", "EX", String(LOCK_TTL_SECONDS)]);
      else {
        const s = sessions.get(id);
        s.stopping = true;
        endSocket(s);
        sessions.delete(id);
        log("qr_session_lost_lock", { businessId: id });
      }
    });
    await redis.pipeline(commands);
  }

  /** Closes sockets without logging out, so the next machine can pick them up. */
  async function shutdown() {
    for (const s of sessions.values()) {
      s.stopping = true;
      endSocket(s);
      await releaseLock(s.businessId).catch(() => {});
    }
    sessions.clear();
  }

  return {
    start, status, send, logout, restoreAll, renewLocks, shutdown, ownerOf,
    get size() { return sessions.size; },
    connectedCount: () => [...sessions.values()].filter((s) => s.state === "connected").length,
  };
}
