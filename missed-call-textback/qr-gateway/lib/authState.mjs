/**
 * A Baileys auth state kept in Redis, encrypted.
 *
 * What is stored here is, in effect, a logged-in WhatsApp device for a
 * real business number: anyone holding it can read and send that
 * business's messages. So every value is encrypted with the same
 * AES-256-GCM helper and key (INTEGRATION_ENCRYPTION_KEY) the app uses for
 * Meta access tokens, and the key never sits beside the data.
 *
 * Layout, per business:
 *   waqr:<id>:creds              the device credentials
 *   waqr:<id>:k:<type>:<keyId>   one Signal key
 *   waqr:<id>:keys               set of every key name above, so logging
 *                                out can delete them all without SCAN
 *
 * Baileys' own file-based version (useMultiFileAuthState) says it is not
 * for production; this follows the same get/set contract.
 */
import { encryptSecret, decryptSecret } from "../../lib/crypto.mjs";

/** Buffer-safe JSON, matching Baileys' BufferJSON, so keys survive a round trip. */
export const bufferJson = {
  replacer(_key, value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === "Buffer") {
      return { type: "Buffer", data: Buffer.from(value?.data || value).toString("base64") };
    }
    return value;
  },
  reviver(_key, value) {
    if (value && typeof value === "object" && value.type === "Buffer" && typeof value.data === "string") {
      return Buffer.from(value.data, "base64");
    }
    return value;
  },
};

export const prefixFor = (businessId) => `waqr:${businessId}:`;

function seal(value, encryptionKey) {
  return encryptSecret(JSON.stringify(value, bufferJson.replacer), encryptionKey);
}

function open(sealed, encryptionKey) {
  if (!sealed) return null;
  return JSON.parse(decryptSecret(sealed, encryptionKey), bufferJson.reviver);
}

/** True when a business has a device that finished linking (scanned QR or code). */
export async function hasLinkedDevice(redis, businessId, encryptionKey) {
  const creds = open(await redis.command("GET", `${prefixFor(businessId)}creds`), encryptionKey);
  return Boolean(creds?.registered || creds?.me?.id);
}

/**
 * Loads (or starts) the auth state for one business.
 *
 * `baileys` supplies initAuthCreds and proto from the library; tests pass
 * stand-ins so this file can be checked without a WhatsApp connection.
 */
export async function useRedisAuthState(redis, businessId, encryptionKey, baileys) {
  if (!encryptionKey) throw new Error("INTEGRATION_ENCRYPTION_KEY is required to store WhatsApp sessions");
  const p = prefixFor(businessId);
  const credsKey = `${p}creds`;
  const indexKey = `${p}keys`;
  const keyName = (type, id) => `${p}k:${type}:${id}`;

  const creds = open(await redis.command("GET", credsKey), encryptionKey) ?? baileys.initAuthCreds();

  const keys = {
    async get(type, ids) {
      if (!ids.length) return {};
      const raws = await redis.command("MGET", ...ids.map((id) => keyName(type, id)));
      const out = {};
      ids.forEach((id, i) => {
        let value = open(raws?.[i], encryptionKey);
        if (value && type === "app-state-sync-key" && baileys.proto?.Message?.AppStateSyncKeyData) {
          value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        if (value !== null && value !== undefined) out[id] = value;
      });
      return out;
    },

    /** One pipeline per call: Baileys writes keys in batches, and so do we. */
    async set(data) {
      const commands = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type] ?? {})) {
          const name = keyName(type, id);
          const value = data[type][id];
          if (value) {
            commands.push(["SET", name, seal(value, encryptionKey)], ["SADD", indexKey, name]);
          } else {
            commands.push(["DEL", name], ["SREM", indexKey, name]);
          }
        }
      }
      await redis.pipeline(commands);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => redis.command("SET", credsKey, seal(creds, encryptionKey)),
  };
}

/** Deletes every stored piece of one business's WhatsApp session. */
export async function clearAuthState(redis, businessId) {
  const p = prefixFor(businessId);
  const names = (await redis.command("SMEMBERS", `${p}keys`)) ?? [];
  const commands = [];
  for (let i = 0; i < names.length; i += 200) commands.push(["DEL", ...names.slice(i, i + 200)]);
  commands.push(["DEL", `${p}keys`, `${p}creds`]);
  await redis.pipeline(commands);
}
