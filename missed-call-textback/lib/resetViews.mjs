import { barePage, escapeHtml } from "./views.mjs";

const errorBlock = (error) => (error ? `<p class="error">${escapeHtml(error)}</p>` : "");

export function forgotPasswordPage({ error, sent = false } = {}) {
  if (sent) {
    return barePage("Check your email", `
    <div class="gate">
      <div class="plate">MissedCall</div>
      <h1>Check your email</h1>
      <p class="sub">If an account exists for that address, we've sent a link to reset the password. It works once and expires in 1 hour.</p>
      <p class="sub" style="margin-top:16px"><a href="/leads">Back to sign in</a></p>
    </div>`);
  }
  return barePage("Forgot password", `
    <div class="gate">
      <div class="plate">MissedCall</div>
      <h1>Reset your password</h1>
      <p class="sub">Enter your account email and we'll send you a reset link.</p>
      <form method="POST" action="/forgot-password">
        <label class="field" for="email">Email</label>
        <input type="email" id="email" name="email" autocomplete="email" autofocus required>
        <button type="submit">Send reset link</button>
        ${errorBlock(error)}
      </form>
      <p class="sub" style="margin-top:16px"><a href="/leads">Back to sign in</a></p>
    </div>`);
}

export function resetPasswordPage({ token, error } = {}) {
  return barePage("Set a new password", `
    <div class="gate">
      <div class="plate">MissedCall</div>
      <h1>Set a new password</h1>
      <form method="POST" action="/reset-password">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <label class="field" for="password">New password</label>
        <input type="password" id="password" name="password" autocomplete="new-password" minlength="10" autofocus required style="margin-bottom:14px">
        <label class="field" for="confirm">Confirm password</label>
        <input type="password" id="confirm" name="confirm" autocomplete="new-password" minlength="10" required>
        <p class="sub">At least 10 characters.</p>
        <button type="submit">Update password</button>
        ${errorBlock(error)}
      </form>
    </div>`);
}

export function resetLinkInvalidPage() {
  return barePage("Link expired", `
    <div class="gate">
      <div class="plate">MissedCall</div>
      <h1>This link has expired</h1>
      <p class="sub">Reset links work once and last 1 hour.</p>
      <p class="sub" style="margin-top:16px"><a href="/forgot-password">Send a new link</a></p>
    </div>`);
}
