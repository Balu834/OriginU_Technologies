# Upwork proposal: Meta WhatsApp Cloud API Expert, Audit, Restriction Fix & Coexistence Setup

Job: https://www.upwork.com/jobs/~022108037722745578616
Client: medical/aesthetic clinic group, Malaysia. Payment verified, new account (0% hire rate).
Cost: 11 Connects (37 available). Bid: $150 fixed for Phase 1 (see below).

---

## Cover letter

Hi,

Your brief reads like someone who has already done the reading, so I'll be direct about what I can and can't do.

**What I bring:** I built and run a production WhatsApp Cloud API product (MissedCall). It uses Meta Embedded Signup so businesses connect their own number, plus webhook subscription, signature verification, message templates and per-business data isolation. It's backed by 457 automated tests. The Graph API side of your list (number registration, webhooks, app publishing, permanent System User tokens) is work I've done in code, not just in the dashboard.

**Your point 6 is where I can add the most.** Routing Click-to-WhatsApp leads by `referral` data (ad ID, source ID, `ctwa_clid`) to the right CSR team is the same lead-capture → routing → follow-up pattern I build for a living. I can design that routing so it's clean from day one, and set it up so the CAPI conversion events (point 7) have what they need.

**Where I'll be honest:**
- **Restrictions:** nobody can guarantee Meta lifts a restriction. What I can do is audit the portfolios to find the likely trigger, fix what's in your control (verification documents, display name, policy-sensitive templates for medical/aesthetic content), and prepare a clean, well-evidenced appeal. No workarounds or new portfolios to evade it, which I'm glad you ruled out.
- **Coexistence and becoming a Tech Provider:** I'll give you a clear recommendation with the risks, but I won't pretend to a track record of coexistence migrations I don't have.

**Suggested structure:**
- **Phase 1 ($150, about 3–4 days):** full audit report (portfolios, apps, WABAs, numbers, system users, permissions); root-cause notes on the `wabaID` error and the restriction; business-verification guidance; and, as soon as an unrestricted WABA is available, a working Cloud API number with webhooks, a permanent System User token and a published app.
- **Phase 2 (quoted after the audit):** lead routing by ad/page, CAPI events, the coexistence/Tech Provider decision, documentation and a recorded handover.

I work through partner access only and can do live calls in your morning, Malaysia time (I'm in India, UTC+5:30, so there's good overlap).

One question to start: are the 4 working numbers and the restricted portfolio under the **same** Business Portfolio, or separate ones? That changes where the audit starts.

Lavudiya Balu, OriginU Technologies

---

## Screening questions

**1. How many WhatsApp Cloud API / Coexistence setups have you completed? Share 1–2 examples.**
I built MissedCall, a multi-tenant product on the WhatsApp Cloud API where each business connects its own number through Meta Embedded Signup. It covers webhook verification and subscription, templates, and per-tenant isolation, with 457 automated tests. I have not done a Coexistence migration yet. I'd advise on it from Meta's documentation and its stated limitations, not from past client projects.

**2. Have you resolved a "business restricted" or disabled WhatsApp account before? How?**
No. I haven't personally had a restriction lifted, and nobody outside Meta can guarantee it. My approach: audit the portfolio for the usual triggers (unverified business, policy-sensitive content or templates, linked restricted assets), fix what's in your control, complete business verification, then file a clear appeal through Business Support. I won't use evasion workarounds.

**3. Are you, or do you work with, a Meta Tech Provider or BSP?**
<!-- BALU: Is your Meta app approved as a Tech Provider (needed for Embedded Signup in production)?
     If YES: "Yes, my own app is set up for Embedded Signup as a Tech Provider." If NO or unsure, keep the line below. -->
I'm not a registered BSP. I've built on Meta's Embedded Signup flow directly, so I can explain both options (becoming a Tech Provider yourself vs onboarding through an existing BSP) and set up whichever fits.

**4. What causes "Unexpected null value for wabaID" in your experience?**
It usually means the number-add flow can't resolve which WhatsApp Business Account to attach the number to. Common causes: the developer app isn't linked to a WABA in the portfolio that owns it, the logged-in user or system user lacks permissions on that WABA, or, in your case most likely, the portfolio's restriction blocks WABA creation, so the flow ends up with no WABA ID. The audit will confirm which one applies.

**5. Your fixed price and estimated timeline for the scope above.**
Phase 1 (audit, root-cause report, verification guidance, and a working Cloud API number with webhooks, token and published app once an unrestricted WABA is available): **$150, about 3–4 days.** Phase 2 (lead routing, CAPI, coexistence/Tech Provider setup, documentation and recorded handover) quoted after the audit, since the restriction outcome changes the scope.
