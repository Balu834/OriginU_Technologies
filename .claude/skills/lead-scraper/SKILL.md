---
name: lead-scraper
description: Scrapes Google Maps for local businesses in any niche and city, checks their website for existing AI/chat widgets, and exports a clean CSV of prospects ready for outreach. Use this skill whenever someone wants to find leads, prospect local businesses, build a client list, scrape businesses in an area, or find companies that need AI. Also triggers when someone mentions Google Maps scraping, lead generation, or prospecting for an AI agency.
version: 1.1
---

# Lead Scraper

You find local businesses that need AI. You scrape Google Maps for a specific niche and location, visit each website to check if they already have AI or a chat widget, and export everything to a clean CSV file ready for outreach.

## How It Works

When invoked, ask the user two things:
1. **Niche** (e.g., "car detailing", "dentists", "HVAC", "plumbers", "restaurants")
2. **Location** (e.g., "Miami", "Austin TX", "Los Angeles")

If the user already provided both in their message, skip the questions and start scraping.

## Scraping Process

### Step 1: Search Google Maps

Use the WebSearch tool to search Google Maps for businesses:
- Query format: `[niche] in [location] site:google.com/maps`
- Also try: `[niche] near [location]`
- Pull 20-50 results

For each business, extract:
- **Business name**
- **Phone number**
- **Website URL**
- **Address**
- **Google rating** (stars)
- **Number of reviews**

Google Maps may not return all fields for every business. That's fine. Get what you can. If WebSearch doesn't return enough structured data, try alternative queries like "[niche] [city] phone number" or "[niche] [city] site:yelp.com" to fill gaps.

Realistic expectation: you'll get 15-30 solid leads per scrape, not 50. Quality over quantity.

### Step 2: Check Each Website for AI/Chat

For every business that has a website, use WebFetch to visit the site and check for:
- Live chat widgets (Intercom, Drift, Zendesk, Tidio, LiveChat, Crisp, HubSpot chat)
- AI chatbot elements (BuildMyAgent, Chatbase, BotPress, Voiceflow web widgets)
- Any floating chat bubble or chat icon in the DOM (look for script tags referencing these platforms)
- Facebook Messenger integration

Note: WebFetch reads the HTML source. Some chat widgets load via JavaScript and won't be visible in the raw HTML. If you see script tags for Intercom, Drift, Tidio, etc., that counts as "Has Chat" even if the widget itself isn't rendered.

Mark each business as:
- `No AI/Chat` = no chat widget found (these are your best prospects)
- `Has Chat` = has a basic live chat
- `Has AI` = has an AI chatbot or agent

Businesses with `No AI/Chat` are the hottest leads. They need what you sell.

### Step 3: Export to CSV

Create a CSV file with these columns:
```
Business Name, Phone, Email, Website, Website Status, Address, Google Rating, Reviews, AI Status, Notes
```

- **Email**: Extract from the website if visible (contact page, footer). Leave blank if not found.
- **Website Status**: One of `Live` (site loaded fine when fetched), `Down` (timeout, error, or blocked), `No Website` (business has no site). If WebFetch pulled the page successfully in Step 2, mark it `Live`.
- **AI Status**: One of `No AI/Chat`, `Has Chat`, `Has AI`
- **Notes**: Any useful context (e.g., "50+ Google reviews", "no website", "website down")

Sort the CSV by AI Status: `No AI/Chat` first (best prospects), then `Has Chat`, then `Has AI`.

### Step 4: Summary

After exporting, give the user a quick summary:
- Total businesses found
- How many have no AI/chat (prime prospects)
- How many already have chat or AI
- Top 5 prospects (highest reviews + no AI)

## Output Location

Save the CSV to the current working directory as `[niche]-[location]-leads.csv`.
Example: `car-detailing-miami-leads.csv`

## What This Skill Does NOT Do

- It does not send emails or DMs. That is a separate step (use the Cold Outreach skill).
- It does not build AI agents. That is a separate step.
- It does not guarantee email addresses. Many businesses don't list emails publicly.

## Edge Cases

- If a business has no website, mark Website Status as `No Website` and AI Status as `No Website`, and still include them (they might need a website build too).
- If WebFetch fails on a site (timeout, blocked), mark Website Status as `Down` and AI Status as `Unknown`, and move on. Do not retry more than once. A down site is still a lead (they may need a rebuild).
- If fewer than 10 results come back, widen the search radius or suggest the user try a broader niche or larger city.

## Speed Over Perfection

Get the list out fast. A good enough list of 25 businesses with accurate AI status is better than a perfect list of 50 that takes 10 minutes. The user wants to start outreach today, not tomorrow.
