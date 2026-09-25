# 01 — Competitor landscape (LinkedIn + email outreach automation)

_Researched September 2026. Prices and features change often; every figure below
names its source so it can be re-checked before it is quoted to a customer._

## 1. The market in one paragraph

The category splits into four groups: **LinkedIn sequencers** (Expandi, HeyReach,
Dripify, Waalaxy, Skylead, SalesRobot, Linked Helper, La Growth Machine),
**email-first platforms that added LinkedIn** (lemlist, Smartlead, Apollo — which
dropped LinkedIn automation in Jan 2026), **data/scraping platforms**
(PhantomBuster, Clay), and a new **"AI SDR" tier** (Valley, Artisan, 11x, Agent
Frank) that decides *who* to contact and *what* to say. ReachPilot competes in the
first group. Its unusual choice — the browser runs on the customer's own laptop —
places it architecturally next to **Linked Helper**, not next to the cloud tools.

## 2. How the tools are built (this decides safety, price and UX)

| Architecture | How it works | Who uses it | Strength | Weakness |
|---|---|---|---|---|
| **Cloud browser + dedicated IP per account** | Vendor runs a real browser session on its servers, egressing through one fixed (ideally residential) IP per LinkedIn account | Expandi, Dripify, Skylead, La Growth Machine (5G mobile proxy), HeyReach Starter, Waalaxy (since 2024) | Runs 24/7; no user machine needed | Vendor holds the session cookie; IP quality varies — an independent July 2026 test found Dripify accounts on **datacenter** IPs with a 94/100 fraud score |
| **"API" tools (reverse-engineered LinkedIn endpoints)** | HTTP calls to LinkedIn's internal (Voyager / mobile) APIs, often via **Unipile** | SalesRobot ("mobile API"), Reachium and many new entrants (via Unipile) | Fast, cheap, easy to build | Request pattern differs from a real page load; Linked Helper argues these are detectable by "API request map" comparison |
| **Desktop app with its own browser** | Standalone Chromium on the user's PC/VPS, user's own IP | **Linked Helper 2**, **ReachPilot (desktop agent)** | Session + IP never leave the user's machine; no extension footprint | Only runs while the machine is on |
| **Chrome extension** | Automates inside the user's own Chrome tab | Dux-Soup, older Waalaxy, lemlist (LinkedIn steps), Apollo/Seamless (data) | Zero infrastructure | LinkedIn probes for **6,000+ extension IDs** on every page load (see doc 02); Waalaxy says Chrome Web Store rules stopped extensions performing actions from 2024, which forced its move to 100% cloud |

**Takeaway for ReachPilot:** the desktop-agent model is a real differentiator
("your session and IP never leave your laptop") that only Linked Helper markets
today — but it needs the features that make a desktop tool tolerable: it must
catch up on whatever happened while the laptop was closed (sync), and it should
offer an optional always-on mode (VPS/cloud runner with a clean ISP/residential
IP) for customers who want 24/7 execution. See doc 02 §6.

## 3. Competitor profiles

### Expandi — "safest cloud sequencer" (category reference)
- **Price:** $99 per LinkedIn account/month, $79 annual; agency quote from 10
  accounts; Sept 2026 promo $23–$39/account at volume.
- **Architecture:** cloud; *dedicated country-based IP* per account; automatic
  profile warm-up; "smart algorithms for limit ranges".
- **Campaigns:** 11 campaign types, builder with **19 actions + 11 conditions**;
  *signal-based triggers* (profile viewed you, post engagement, group joined,
  event attended); **Mobile Connector** campaigns that use LinkedIn's separate
  mobile invitation quota; campaign prioritisation; duplicate protection at
  person *and company* level; blacklist.
- **Personalisation:** image/GIF (via Hyperise, paid add-on), video (Sendspark).
- **Inbox/CRM:** global inbox across all accounts; native HubSpot / Pipedrive /
  Salesforce; every action can fire a webhook; open API; **Expandi MCP** (early
  access) so an AI assistant can query campaigns.
- **Teams:** workspaces, **110+ permissions**, white-label on Agency plan.
- **Gaps (per reviews):** no contact database or email finder; UI seen as
  unintuitive; lost-settings bug reports.

### HeyReach — multi-sender / agency leader
- **Price:** $79 per sender/month (Starter, residential proxy included); Agency
  ~$999/mo and Unlimited ~$2,999/mo flat for many senders (bring your own
  proxies); users/teammates free — **billed per LinkedIn sender, never per user**.
- **Architecture:** cloud; "every LinkedIn account gets its own dedicated
  residential proxy that never rotates IP addresses".
- **Signature feature — sender rotation:** one campaign runs from many LinkedIn
  accounts, auto-distributing leads; daily limits are *per sender* and shared
  across that sender's campaigns. Their own rationale: LinkedIn caps invites at
  roughly 20–40/day since May 2023, so volume only scales by adding senders.
- **Unibox:** all senders' conversations in one inbox; reply on behalf of
  colleagues; voice notes.
- **Agency ops:** per-client workspaces with seat limits, white-label (own
  domain/logo), "Master View" across workspaces, published sender-health SLAs
  (rotate a sender when acceptance drops >20% from baseline or pending invites
  exceed ~30).
- **Integrations:** Clay, HubSpot, Make, n8n, Instantly/Smartlead/EmailBison,
  API + webhooks, **HeyReach MCP**.

### Waalaxy — mass-market, freemium
- **Price:** €19 (300 invites/month), €49 and €69 (800 invites/month) per user;
  inbox is a paid add-on; Waalaxy AI agent ~$99.
- **Architecture:** was a Chrome extension; moved to **100% cloud** in 2024
  because of Chrome Web Store rules. Fixed IP per user, "as close as possible to
  your location", **max 5 users per IP**, VPN IPs.
- **Features:** prospect lists from Search / Sales Navigator / post reactions;
  **cascading email finder** (BetterContact → FullEnrich → DropContact, credits
  refunded when nothing is found); CRM sync; Make/Zapier/n8n modules.

### Dripify — simple cloud drip
- **Price:** $59 / $79 / $99 per user ($39/$59/$79 annual).
- **Publishes its own quotas:** Basic 20 invites, 30 messages, 10 InMails, 100
  profile views, 50 emails per day; Pro/Advanced up to 75 invites/day. The daily
  pool is divided across active campaigns.
- **Features:** drag-and-drop builder (10+ actions/conditions), 20+ variables
  with **fallback text**, **A/B testing (3 variants per step)**, **step analytics
  with visual alerts**, auto-stop on reply, outgoing webhooks, HubSpot.
- **Safety caveat:** independent test (linkedhelper.com review, July 2026) found
  shared-provider datacenter IPs.

### Linked Helper 2 — desktop app (closest to ReachPilot's architecture)
- **Model:** standalone Chromium-based desktop app; optional cloud sync of CRM
  data; can be deployed on a VPS with an ISP/residential proxy for 24/7 runs.
- **Published safety design** (their Safety Kit / help centre): no code injected
  into LinkedIn pages; no Chrome Web Store ID; does not call LinkedIn's API;
  randomized fingerprint *per LinkedIn instance*; separate cache/cookies per
  account; optional proxy per instance with built-in **proxy quality checker**;
  **in-page navigation** (finds profiles via the search bar instead of opening
  many profile URLs directly — "LinkedIn can log you out if you open a lot of
  pages one after another via direct links"); daily limits across *all*
  campaigns; randomized delays between micro-steps; human-speed typing and
  randomized click coordinates; randomized campaign start times and daily
  counts; message randomization (spintax + AI).
- **Operational advice:** never run the same account in two places at once
  (automation + phone app simultaneously looks inhuman); match system timezone to
  IP location; avoid proxies with fraud score > 75.

### La Growth Machine (LGM) — multichannel "identities"
- **Price:** €60 / €120 per identity/month (Basic/Pro), Ultimate tier; 2 months
  free annually; up to 25 team members free on Pro.
- **Architecture:** 100% cloud; dedicated 5G mobile proxy per identity (per
  comparison sites).
- **Differentiators:** LinkedIn **AI voice messages** (clone your voice for a
  personalised intro + recorded body); X/Twitter actions; **social warming**
  (auto-like before inviting); "Real Chat Mode"; waterfall enrichment (9 email
  providers + 2 verifiers); multichannel inbox; rotating inbox (5–10 senders per
  identity); A/B testing; conditions like "if profile visited you back".

### lemlist — email-first multichannel
- **Price:** email plans from $79/user; LinkedIn steps require Multichannel Expert
  ($109/user); WhatsApp add-on $20/user.
- **Features:** 600M+ lead database, **lemwarm** (free warm-up), inbox rotation,
  image/landing-page personalisation, LinkedIn visits/invites/text/**voice**
  messages via a Chrome extension, unified inbox (email/LinkedIn/WhatsApp/call),
  manual-task steps, SOC 2 Type II.

### Skylead — "smart sequences"
- **Price:** ~$100/month per seat.
- **Features:** if/else across LinkedIn + email, unlimited email accounts,
  email finder + verifier, unlimited image/GIF personalisation, 8 lead sources.

### SalesRobot — budget LinkedIn + email with AI
- **Price:** from $59/month. Markets "mobile API" execution, residential IP
  rotation, ≤200 invites/week, **AI appointment setter** (Copilot/Autopilot reply
  handling), video/voice notes, auto-comment on prospects' posts.

### PhantomBuster — automation/scraping platform
- **Price:** $56–$352/month by *execution hours* and "phantom" slots.
- 100+ pre-built "Phantoms" (LinkedIn, X, Instagram, Google Maps) that extract
  profiles, post likers/commenters, group members; chains into CRMs and lemlist.

### Smartlead / Instantly — cold email infrastructure (the email benchmark)
- **Both:** unlimited mailboxes, free unlimited warm-up network, **inbox
  rotation**, unified inbox with reply labels (Interested / Not interested /
  OOO…), AI reply agents, API + webhooks.
- **Instantly:** $47–$97/month, 450M+ contact database, 4.2M-account warm-up
  network, SISR IP rotation. **Smartlead:** $39–$94/month, per-sequence mailbox
  control, provider matching (Gmail→Gmail), white-label client workspaces
  (~$29/client), native LinkedIn steps, SmartSenders (buys domains + sets
  SPF/DKIM/DMARC for you).

### The AI-SDR tier (where the market is moving)
- **Valley** ($149–$395+/month): watches **buying signals** (profile viewers,
  post engagers, competitor followers, website visitors), scores against the
  ICP, researches, drafts in the user's voice, human approval or autopilot.
- **Artisan, 11x, Agent Frank:** $500–$5,000/month autonomous SDRs.
- **MCP servers:** Expandi and HeyReach both ship an MCP server so Claude/ChatGPT
  can run campaigns — ReachPilot already has an AI Assistant with Apify MCP, a
  head start worth productising (doc 08).

### Exits and enforcement (context that affects the roadmap)
- **Zopto** shut down (Feb 2026). **Apollo** discontinued LinkedIn automation
  (Jan 2026). LinkedIn removed the company pages of **Apollo.io and Seamless.ai**
  (2025) over their extensions.
- LinkedIn sued **Proxycurl** (shut down July 2025) and **ProAPIs** (consent
  judgment banning it from LinkedIn, Sept 2026) — both for scraping with fake
  accounts. Lesson: *scraping at scale* draws lawsuits; *per-user automation of
  the user's own account* draws account restrictions. Keep ReachPilot in the
  second category (doc 05 §5).

## 4. Feature matrix — market vs ReachPilot today

✅ shipped and working · 🟡 partial / not wired / not in production · ❌ missing

| Capability | Expandi | HeyReach | Dripify | Linked Helper | LGM | ReachPilot today |
|---|---|---|---|---|---|---|
| Connect / message / visit / follow | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (desktop agent) |
| InMail, like post, endorse | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 worker + driver support them; **not in the campaign builder** |
| Acceptance + reply detection | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ **in production** (no-op in remote mode — doc 03) |
| Unified inbox (LinkedIn) | ✅ | ✅ | 🟡 | ✅ (CRM) | ✅ | ❌ (email replies only) |
| Conditional builder | ✅ 19/11 | ✅ | ✅ | ✅ | ✅ | 🟡 linear + one branch type; 5 of 9 conditions never fire |
| A/B testing | ✅ | 🟡 | ✅ | ✅ | ✅ | ❌ (`ab_tests` table unused) |
| Signal triggers (viewers, engagers) | ✅ | 🟡 | ✅ (post) | ✅ | ✅ | ❌ |
| Warm-up + randomized limits | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (strong — doc 02) |
| Acceptance-rate / pending-invite safety | 🟡 | ✅ (SLAs) | 🟡 | ✅ | 🟡 | ❌ |
| Multiple LinkedIn accounts / rotation | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`limit(1)` everywhere — doc 07) |
| Email in the same sequence | ✅ | via integ. | ✅ | ✅ | ✅ | ✅ (Gmail API only) |
| Email warm-up / rotation | ❌ | via integ. | ❌ | ❌ | ✅ rotation | 🟡 internal-pool warm-up, no rotation |
| Unsubscribe / bounce handling | n/a | n/a | 🟡 | 🟡 | 🟡 | ❌ |
| Lead import: CSV / Search / Sales Nav | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 CSV + Google-SERP scraper; Search/Sales Nav URL ignored |
| Email finder / enrichment | ❌ | ✅ | ✅ | 🟡 | ✅ | ❌ |
| Blacklist (person + company) | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 lead status only; domain blacklist UI is fake |
| CRM (HubSpot/Pipedrive/SF) | ✅ | ✅ | 🟡 | ✅ | ✅ | ❌ ("coming soon") |
| Webhooks / public API | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 tables + key auth exist; **nothing fires** |
| Teams, roles, client workspaces | ✅ | ✅ | ✅ | 🟡 | ✅ | ❌ (roles unused, invitations table unused) |
| White-label | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| AI note / message writing | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ (Gemini + Apify profile research) |
| AI reply handling / MCP | ✅ MCP | ✅ MCP | ❌ | ❌ | 🟡 | 🟡 Assistant exists; no reply agent |
| Billing / plans | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (hardcoded "Pro") |

## 5. Positioning recommendation

1. **Own the "your laptop, your IP, your session" story** (the Linked Helper
   position) — but in a SaaS with a modern web app, which Linked Helper is not.
   This is a sharper safety claim than "dedicated IP" now that reviewers are
   testing cloud vendors' IP quality.
2. **Price per LinkedIn account, not per user** (Expandi/HeyReach model), with
   teammates free — the market has converged on it (doc 10).
3. **Close the table-stakes gaps first** (sync + inbox, multi-account, builder
   parity, blacklist, CRM/webhooks) — without reply detection the product cannot
   run the most basic "connect → if accepted → message" sequence.
4. **Then differentiate on AI**: signal-based targeting + AI reply handling,
   exposed through an MCP server (doc 08), where the incumbents are only starting.

## Sources
- Expandi pricing & product: https://expandi.io/pricing/ · https://expandi.io/lead-generation/ · https://expandi.io/back-to-pipeline-2026/ · https://expandi.io/blog/switch-to-expandi-migration-guide/ · https://emelia.io/hub/expandi-pricing
- HeyReach: https://www.heyreach.io/pricing · https://www.heyreach.io/for-agencies · https://help.heyreach.io/en/articles/9897768-multiple-linkedin-senders-on-one-campaign-sender-rotation · https://www.heyreach.io/blog/linkedin-automation-for-agencies
- Waalaxy: https://www.waalaxy.com/blog/linkedin-automation-software/waalaxy-cloud · https://www.waalaxy.com/pricing · https://intercom.help/waalaxy/en/articles/5478383-how-does-the-find-email-work
- Dripify: https://dripify.com/ · https://www.linkedhelper.com/reviews/dripify-review · https://www.revenueflow.com/blog/dripify
- Linked Helper: https://support.linkedhelper.com/hc/en-us/articles/360015454919 · https://support.linkedhelper.com/hc/en-us/articles/23378382591250 · https://www.linkedhelper.com/safety-kit
- La Growth Machine: https://lagrowthmachine.com/pricing/ · https://lagrowthmachine.com/features/ · https://prospectingmanual.com/linkedin-automation/compare/la-growth-machine-vs-lemlist/
- lemlist: https://www.lemlist.com/product/multichannel-prospecting
- Instantly / Smartlead: https://instantly.ai/blog/comparing-instantly-vs-smartlead/ · https://www.genflows.com/blog/smartlead-vs-instantly-2026 · https://mailbeast.ai/blog/instantly-vs-smartlead
- AI SDR tier / overviews: https://www.joinvalley.co/blog/best-linkedin-automation-tools-in-2026-compared-side-by-side · https://www.salesrobot.co/blogs/ai-agent-frameworks · https://scaliq.ai/linkedin-outreach-tools
- Unipile: https://www.unipile.com/pricing-api/ · https://developer.unipile.com/docs/connect-accounts
- Enforcement: https://news.bloomberglaw.com/artificial-intelligence/startup-banned-from-using-linkedin-data-in-scraping-lawsuit · https://news.bloomberglaw.com/artificial-intelligence/linkedin-battles-online-scrapers-in-perpetual-struggle-over-data · https://www.leadgenius.com/resources/linkedins-crackdown-on-data-scrapers-why-apollo-io-and-seamless-ai-were-targeted--and-whos-next
