# Proxy / IP research — what actually determines whether an IP survives LinkedIn

> Researched 2026-08-25. Prices and availability move; the **reasoning** is the
> durable part. Re-verify any number before spending money on it.

## The one thing to take away

**"Datacenter IP" is not one category, and physical location is not what LinkedIn
scores.** An IP is judged on how it is *registered and classified*, and on how many
accounts sit behind it — not on whether the machine is in a rack or a living room.

Two IPs can both live in a datacenter and be treated completely differently:

| | ASN registered as | rDNS looks like | LinkedIn treats it as |
|---|---|---|---|
| Oracle / AWS / GCP / DigitalOcean | Cloud / hosting | `vps-123.host.com` | 🔴 Indexed hosting range |
| Proxy provider's own ASN | **ISP** | `abts-tn-static-090…airtelbroadband.in` | ✅ Consumer connection |

Both are "in a datacenter". Only the second one works. The $0.40/IP IPv4 lease price
versus the $1.30–5.00/IP ISP-proxy price **is** that classification difference — you
are not paying for addresses, you are paying for how databases label them.

### So do NOT read this as "datacenter IPs are safe"

The nuance is load-bearing. Concretely, for this project:

- **Our Oracle VMs cannot be used as egress.** Verified 2026-08-25:
  `129.225.68.89` and `129.225.104.114` are both **AS31898 Oracle Corporation** —
  a top-tier cloud ASN, indexed. The worker VM also geolocates to **Austin, US**
  while our LinkedIn accounts are `Asia/Kolkata`, so it fails on geo as well.
  (The API VM is Hyderabad, IN — geo-correct, still the wrong ASN.)
- Even if the ASN were fine, **2 VMs means 2 IPs for every customer**, and shared
  infrastructure is itself the detection signal (see the account-density rule below).

## The Expandi data point, and what it does and does not prove

Expandi's own help centre says the dedicated IP it assigns is

> "a personal dedicated IP address of a selected country, which is **provided by a
> data center**"

Expandi is the market leader at $99/seat and evidently is not being mass-banned, so
datacenter-*hosted* IPs plainly can work. **What Expandi does not publish is which
provider or ASN it uses** — searched 2026-08-25, not disclosed anywhere public.

Reading the wording as "cloud IPs are fine" contradicts everything else in the
market (LinkedIn indexes hosting ASNs; ISP-classified IPs cost 3–40× more precisely
because they are the ones that work). The reading consistent with all the evidence
is that Expandi buys **ISP-classified space that is physically datacenter-hosted** —
i.e. exactly the "ISP proxy" / "static residential" product category. That is an
inference, clearly marked as one, not a confirmed fact.

What Expandi's docs *do* confirm directly is that **geo mismatch is the risk they
actually warn customers about**, not the IP's ASN:

> "If the selected location is incorrect or you moved to another country… LinkedIn
> will notice it and might send you a security warning or restrict your account"

## The rules that actually matter

1. **Never rotating.** One account = one IP, permanently. Rotating IPs are the
   single strongest bot signal LinkedIn tracks.
2. **Geo must match the human.** The IP's country/city has to match where the account
   owner actually is. Verifiable from the account side at
   LinkedIn → Settings → Sign-in & security → *"Where you're signed in"*.
3. **Account density.** At **20+ accounts on one IP**, LinkedIn identifies the shared
   infrastructure as an automation service, and one flagged account degrades the IP
   for everyone behind it. Budget ≤5–10 to be safe.
4. **Clean history.** A recycled IP inherits whatever the previous tenant did.
5. **Subnet neighbours.** Stacking many accounts across one `/24` gets the whole
   block flagged, not just the individual IP.
6. 🆕 **Provenance.** See the NetNut section — this one can end a vendor overnight.

## 🚨 Provenance is a first-class criterion, not a footnote

On **2026-07-02** the FBI, Google Threat Intelligence, IRS-CI and Lumen seized
hundreds of domains belonging to **NetNut** (owner: Alarum Technologies, NASDAQ:
ALAR). `netnut.io` still served an FBI seizure notice when checked on 2026-08-25.

The reason: NetNut's exit-node pool overlapped with the **Popa botnet** — by Google's
estimate at least **2 million compromised devices**, mostly smart TVs and streaming
boxes. In a single week in June 2026, **316 distinct threat clusters** used NetNut
exit nodes for password spraying, credential stuffing, ad fraud and scraping.

Residential proxy pools are sourced one of two ways:

- **With consent** — an SDK that pays or compensates the device owner. Legal.
- **Without consent** — malware / compromised devices. A botnet.

You usually cannot tell from the marketing page which one you are buying. Buying the
wrong one means legal exposure, a service that can disappear overnight, and IPs
sitting on botnet infrastructure with correspondingly poor reputation.

⚠️ Affiliate comparison blogs were **still ranking NetNut as a top ISP provider** two
months after the seizure. Check the vendor's own domain before trusting any list.

## Provider matrix — India availability (checked 2026-08-25)

India matters because our accounts are `Asia/Kolkata`; a US IP fails rule 2.

| Provider | India ISP/static? | $/IP/month | Notes |
|---|---|---|---|
| **Oxylabs** | ✅ 8,200 IPs | 1.20–1.60 | 10 IP=$16 · 100=$130 · 500=$600. ASN-level targeting |
| **Bright Data** | ✅ 5,376 IPs | 1.30–1.80 | 10=$1.80 · 100=$1.45 · 1000=$1.30. Company KYC required |
| IPRoyal | ✅ claimed | 2.40–2.70 | ⚠️ Claims 3.7M India vs 135k US — implausible, likely their rotating pool |
| NodeMaven | ⚠️ unclear | 2.99–3.75 | India in general pool; ISP-tier coverage not stated |
| Decodo | ❌ | 2.50–3.33 | Own page lists 16 countries, no India |
| Webshare | ❌ | 0.225–0.30 | Price 8× below peers — verify what "dedicated" means |
| Rayobyte | ❌ | 4.60–5.00 | US/UK/CA/DE/FR/IT only |
| Proxy-Seller | ❌ | ~0.98+ | 22 countries, no India |
| Proxy-Cheap | ❌ | ~2.44 | No India listed |
| **NetNut** | — | — | 🚨 **FBI-seized 2026-07-02 — do not use** |
| SOAX | unverified | — | Could not reach a product page |
| IPBurger | unverified | ~14 | Pricing page returned 403 |

Not yet checked: Massive, ProxyEmpire, DataImpulse, Proxywing.

**For India there are realistically two options: Oxylabs and Bright Data.** Both are
large, established, KYC-enforcing companies — which, post-NetNut, is itself a
signal worth paying for.

### Questions to ask sales before buying

1. Are the India IPs genuinely **dedicated** to us, not shared?
2. Are they **static forever**, or sticky sessions that eventually rotate?
3. Which **ASN** — a consumer ISP, or business hosting space?
4. **How are exit nodes sourced, and what is the consent mechanism?**

Then buy the smallest plan (Oxylabs 10 IPs = $16/mo), point one throwaway account at
one IP, confirm the ASN/rDNS on ipinfo.io and the location under *"Where you're
signed in"*, and run it a week before scaling.

## Why we do not need any of this today

`LINKEDIN_DRIVER=remote` runs the real driver inside the user's own desktop app, and
[`remote-agent.driver.ts`](../server-v2/src/modules/drivers/remote-agent.driver.ts)
deliberately does not forward a proxy:

> proxy/fingerprint are intentionally NOT sent — actions run on the user's own
> residential IP

Every rule above is satisfied for free, and one of them cannot be bought at any price:

| Rule | Bought proxy | User's own laptop |
|---|---|---|
| Never rotating | ✅ if you pay for static | ✅ their home connection |
| Geo matches human | ⚠️ needs the right country in stock | ✅ **by construction** |
| ≤5–10 accounts/IP | ✅ if you buy enough IPs | ✅ exactly 1 |
| Clean history | ⚠️ trust the vendor | ✅ it is their own line |
| Provenance | ⚠️ **NetNut** | ✅ the owner is the user |
| Cost at 100 customers | $130–500/mo | **$0** |

A worked example of the good case: `vlabs.rjpinfotek.com` → `122.165.128.90` →
**AS24560 Bharti Airtel Telemedia**, rDNS `abts-tn-static-090…airtelbroadband.in`,
Chennai IN. Consumer ISP ASN, static, geo-correct — the exact product Oxylabs sells
for $1.30/IP, sitting on an ordinary business broadband line.

**Buy proxies only for a premium "runs while my laptop is closed" tier, one IP per
customer as they sign up** — never a pool bought up front. At $1.30/IP against a
~$30/seat plan the IP is ~4% of revenue; a pre-bought pool is pure burn.

## Sources

- [Krebs on Security — FBI seizes NetNut proxy platform, Popa botnet](https://krebsonsecurity.com/2026/07/fbi-seizes-netnut-proxy-platform-popa-botnet/)
- [Infosecurity — FBI, Google take down NetNut](https://www.infosecurity-magazine.com/news/fbi-google-take-down-netnut-proxy/)
- [Expandi help centre — IP address / proxy](https://help.expandi.io/en/articles/5405881-ip-address-proxy)
- [Oxylabs ISP proxies](https://oxylabs.io/products/isp-proxies) · [Bright Data ISP proxies](https://brightdata.com/proxy-types/isp-proxies) · [IPRoyal ISP proxies](https://iproyal.com/isp-proxies/)
- [Decodo static residential](https://decodo.com/proxies/static-residential-proxies) · [Webshare static residential](https://www.webshare.io/static-residential-proxy) · [Rayobyte ISP](https://rayobyte.com/products/isp-proxies/)
- [IPv4 pricing 2026](https://ipv4center.com/guides/ipv4-pricing) · [Static IP in India — Airtel/Jio](https://sarathifiber.com/static-ip-in-india-jiofiber-airtel-2026/)
