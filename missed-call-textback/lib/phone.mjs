const E164 = /^\+[1-9]\d{7,14}$/;

export function isValidE164(number) {
  return typeof number === "string" && E164.test(number.trim());
}

export function normalizePhone(number) {
  return typeof number === "string" ? number.trim() : number;
}

/**
 * Best-effort E.164 for numbers as IVR providers send them: "09876543210",
 * "919876543210", "9876543210", "+91 98765-43210", "0091…". A bare national
 * number is assumed to be Indian, which is every business on the product
 * today. Anything that can't be read as a number comes back as null, and the
 * caller turns that into the same 400 a bad callerNumber gets.
 */
export function toE164(raw, defaultCountryCode = "91") {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  const digits = text.replace(/\D/g, "");
  if (!digits) return null;

  let e164;
  if (text.startsWith("+")) e164 = `+${digits}`;
  else if (digits.startsWith("00")) e164 = `+${digits.slice(2)}`;
  else if (digits.length === 11 && digits.startsWith("0")) e164 = `+${defaultCountryCode}${digits.slice(1)}`;
  else if (digits.length === 10) e164 = `+${defaultCountryCode}${digits}`;
  else e164 = `+${digits}`;

  return isValidE164(e164) ? e164 : null;
}
