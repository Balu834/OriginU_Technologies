const E164 = /^\+[1-9]\d{7,14}$/;

export function isValidE164(number) {
  return typeof number === "string" && E164.test(number.trim());
}

export function normalizePhone(number) {
  return typeof number === "string" ? number.trim() : number;
}
