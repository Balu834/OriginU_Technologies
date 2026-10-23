import test from "node:test";
import assert from "node:assert/strict";
import { landingPage } from "../lib/landing.mjs";
import { loginPage } from "../lib/views.mjs";
import { signupPage } from "../lib/settingsViews.mjs";

test("the sign-in email field is styled like the password field", () => {
  const html = loginPage();
  assert.match(html, /input\[type=email\]\s*\{[^}]*width:100%/, "email input needs the same full-width styling");
});

test("signup uses the MissedCall brand name", () => {
  const html = signupPage();
  assert.match(html, /<div class="plate">MissedCall<\/div>/);
  assert.doesNotMatch(html, /Missed-call textback/i);
});

test("the Free plan card shows ₹0 instead of repeating 'Free'", () => {
  const html = landingPage();
  assert.match(html, /<h3>Free<\/h3>\s*<div class="amount">₹0<\/div>/);
});

test("plan limits use Indian digit grouping", () => {
  const html = landingPage();
  assert.match(html, /Up to 5,000 WhatsApp messages a month/);
  assert.doesNotMatch(html, /Up to 5000 WhatsApp/);
});
