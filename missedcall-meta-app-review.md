# MissedCall — Meta App Review submission (draft)

App: **MissedCall** (App ID 1056328233802010)
Requesting **Advanced Access** for: `whatsapp_business_management` and `whatsapp_business_messaging`
Prepared 10 October 2026. Paste each block into the matching box in
Meta for Developers → MissedCall → App Review → Permissions and Features → Request advanced access.

Do not submit until **business verification** has passed — Meta rejects the request otherwise.

---

## 1. What the app does (use in "Tell us how you're using this permission")

MissedCall is a tool for small local businesses (clinics, repair services, coaching centres).
When a customer phones the business and nobody answers, MissedCall sends that caller one
WhatsApp utility template from the business's own WhatsApp Business number:

> Sorry we missed your call — this is {{business_name}}. Reply here with what you need and
> your area, and {{owner_name}} will call you straight back.

If the caller replies, MissedCall asks up to three short follow-up questions (area, name,
urgency), saves the answers as a lead in the business's dashboard, and notifies the business
owner on WhatsApp. Messages are only ever sent to people who called the business first.
There are no broadcasts and no marketing messages.

Each business connects its own WhatsApp Business Account through **Embedded Signup**
(Facebook Login for Business). MissedCall acts on behalf of that business only.

---

## 2. `whatsapp_business_management`

**How we use it**

MissedCall uses `whatsapp_business_management` when a business connects its WhatsApp
Business Account through Embedded Signup, and afterwards to keep that connection working:

1. **Subscribe our app to the business's WABA** (`POST /{waba-id}/subscribed_apps`) so that
   replies from the business's customers are delivered to our webhook.
2. **Read the connected phone number** (`GET /{phone-number-id}?fields=display_phone_number,verified_name`)
   to show the business which number is connected and to confirm that the number belongs to
   the WABA the business selected.
3. **Create the missed-call message template in the business's WABA**
   (`POST /{waba-id}/message_templates`, category UTILITY) so the business can send the
   missed-call reply without building a template by hand.
4. **Register the phone number for Cloud API use** (`POST /{phone-number-id}/register`).

Without this permission a business would have to copy IDs and tokens out of Meta's developer
tools by hand, which our customers (small, non-technical businesses) cannot do.

**Step-by-step for the reviewer**

1. Go to https://missed-call-textback-three.vercel.app and click **Login**.
2. Sign in with the test account supplied in the "App login credentials" box of this submission.
3. In the left menu open **WhatsApp**.
4. Click **Connect WhatsApp**. The Facebook Login for Business window opens.
5. Log in, choose (or create) a business portfolio, a WhatsApp Business Account and a phone number, and finish the flow.
6. You are returned to MissedCall. The page shows **WhatsApp Connected**, the connected
   number, and "Message template: Sent to Meta for approval".
7. In WhatsApp Manager for that account you can see the new template `missed_call_immediate`
   and that the MissedCall app is subscribed to the account.

---

## 3. `whatsapp_business_messaging`

**How we use it**

MissedCall uses `whatsapp_business_messaging` to send and receive messages on behalf of the
connected business:

1. **Send the approved utility template** to a person who just called the business and was not
   answered (`POST /{phone-number-id}/messages`, type `template`).
2. **Receive that person's replies** through the `messages` webhook.
3. **Send free-form replies inside the 24-hour customer service window** that the person's
   reply opens: up to three short questions (area, name, urgency) and one confirmation.
4. **Notify the business owner** on WhatsApp that a new lead has arrived.
5. **Receive delivery status updates** so the business can see whether a message was delivered.

Messages are only sent to people who initiated contact by calling the business. The business
can delete any lead and its conversation from the dashboard at any time.

**Step-by-step for the reviewer**

1. Sign in to https://missed-call-textback-three.vercel.app with the supplied test account
   (its WhatsApp number is already connected).
2. A missed call is reported to MissedCall by the business's phone. To reproduce it without a
   phone, use the "missed call" request shown in the screencast (it reports one missed call
   from the reviewer's test number).
3. The test number receives the template message on WhatsApp.
4. Reply "AC not cooling". MissedCall asks for the area, then the name, then the urgency, and
   confirms.
5. In MissedCall open **All leads**. The new lead appears with the name, area, problem and
   urgency taken from the conversation.

---

## 4. Screen recording — what to record (one video per permission, 1–3 minutes each)

Meta rejects recordings that do not show the permission being used end to end. Record at
normal speed, in English, with the browser address bar visible.

**Video A — `whatsapp_business_management`**

1. Show the MissedCall login page, sign in.
2. Open **WhatsApp** in the menu; show the page with the **Connect WhatsApp** button.
3. Click it. Show the Meta window: log in, pick the business, the WhatsApp account and the number, finish.
4. Show MissedCall returning to **WhatsApp Connected** with the number and the template line.
5. Switch to WhatsApp Manager → Message templates and show `missed_call_immediate` listed.

**Video B — `whatsapp_business_messaging`**

1. Show MissedCall signed in, with WhatsApp connected and the leads list.
2. Trigger a missed call for a test phone number (show the request being sent, or a real missed call).
3. Show the test phone receiving the template message in WhatsApp.
4. On the phone reply "AC not cooling", then answer the area, name and urgency questions.
5. Back in MissedCall, refresh **All leads** and open the new lead to show its details.

Use a second account (not the app admin's own Facebook account) for Video A if possible —
reviewers want to see the flow as a customer would experience it.

---

## 5. Other boxes on the form

| Field | What to enter |
|---|---|
| Privacy policy URL | https://missed-call-textback-three.vercel.app/privacy |
| Terms of service URL | https://missed-call-textback-three.vercel.app/terms |
| Data deletion URL | https://missed-call-textback-three.vercel.app/data-deletion |
| App login credentials | A dedicated reviewer account on MissedCall (create one for this purpose; do not give your own) |
| Platform | Website — https://missed-call-textback-three.vercel.app |

**Data handling questions** (answer truthfully; these match the privacy policy):

- Data is processed by: Meta (WhatsApp Cloud API), Vercel (hosting), Upstash (database), Razorpay (payments).
- Data is not sold, not used for advertising and not used to train AI models.
- Access tokens are encrypted at rest; each business's data is isolated from other businesses'.
- A business can delete individual leads itself; full account deletion is done on request within 30 days.
- Data may be disclosed to authorities only where the law requires it.

---

## 6. Before you press Submit — checklist

- [ ] Business verification shows **Verified** in Meta Business Settings → Security Centre.
- [ ] App icon uploaded (App settings → Basic).
- [ ] `WHATSAPP_REGISTER_PIN` set in Vercel and redeployed, so step 4 of section 2 really happens.
- [ ] A reviewer test account exists on MissedCall and its login is entered in the form.
- [ ] Both videos recorded and uploaded.
- [ ] The one-click flow has been completed once for real (by you or a tester) and worked.

## Things to know

- This draft describes what the app does today. If the product changes before you submit, update it.
- Meta may come back with questions or a rejection reason; that is normal and usually fixed by a clearer video.
- Apps that connect **other businesses'** WhatsApp accounts must also complete Meta's
  **Tech Provider** onboarding (Use cases → Connect on WhatsApp → Become a Tech Provider).
