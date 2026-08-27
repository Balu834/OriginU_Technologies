/**
 * Same emergency signals the voice agent (../voice-agent/assistant.json)
 * treats as urgent, kept in one place so the two products can't drift.
 * Safety takes priority over lead qualification: on a hit, we never
 * diagnose or suggest a fix — only basic safety guidance.
 */
export const EMERGENCY_PATTERN =
  /burn|smoke|smoking|spark|shock|fire|live wire|naked wire|water|leak|flood|no power|power gone|short circuit|shortcircuit/i;

export function isEmergency(text) {
  return typeof text === "string" && EMERGENCY_PATTERN.test(text);
}
