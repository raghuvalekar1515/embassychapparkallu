# Embassy Chapparkallu

Static website for Embassy Chapparkallu (Embassy Origins), the 85.5-acre community of Villa
Homes and Eco Apartments by Embassy near Tarahunise Lake, North Bengaluru. Built on the Ira Moonglade Webflow
template, served from Cloudflare Workers, with lead capture to KV plus email,
Telegram and the shared Google Sheet.

## Read before editing

> **Built against `CLAUDE.md`**, the standing microsite checklist: no RERA wording
> anywhere, no source attribution, Embassy's palette and type (self-hosted under
> `site/fonts/`), the "E" monogram instead of the builder's logo, the hidden
> `Project Name`, `Zone` and `lead_source` fields on every form, the 8-second pop-up,
> the Bengaluru sibling list in the FAQ, and no em dashes anywhere in the copy.
>
> **LEADS ARE ROUTED BY ZONE**, as on every Bangalore microsite: the Zone field is
> `North Bangalore`, and the first Telegram bot posts each lead to the North Bangalore
> group and both All Bangalore groups (see Telegram below).
>
> **Every picture is Embassy's own imagery of Embassy Origins**: the towers around
> the lake, the Villa Homes, both clubhouses, the riparian corridor, the Rooftop
> Ribbon, a sample living room, the indoor pool and the aerial view.
>
> **THE DOMAIN IS YOURS AND LIVE.** `embassychapparkallu.com` serves the current site
> (on `www`). This build replaces it: deploy it on the root domain and redirect `www`
> to it (go-live step 8). The domain is in every canonical URL, the sitemap, the schema
> and the llms files.
>
> **EMBASSY CHAPPARKALLU IS EMBASSY ORIGINS**, and the site says so: the figures are
> Embassy's own for Phase 1 (217 Villa Homes at Embassy Riverine, 855 Eco Apartments
> at Embassy South Reserve, launched 16 September 2026). Your current site's 2,582
> homes, 16 towers, 85.19 acres and per-type areas are left out: Embassy's published
> ranges contradict them. Embassy Riverine and Embassy South Reserve also have
> their own sites in the network.

The layout is the Webflow export's. Its copy, pictures, logo and palette are this
project's, generated from one facts file; the classes, Webflow ids,
interactions, contact form and its hidden `lead_source` input (below) are the
template's own.

```
site/            The Webflow export. The only directory served.
  *.html         13 pages
  robots.txt sitemap.xml   crawler files
  css/ fonts/    styles and the self-hosted fonts
  images/        pictures: WebP, narrower copies for phones, AVIF twins
  js/webflow.js  Webflow runtime (interactions, sliders, nav)
  js/form-handler.js   posts the contact form to /api/lead
worker/
  index.js       lead endpoint; everything else falls through to site/
  test.mjs       68 assertions, no dependencies
wrangler.jsonc   bindings and deploy config
```

Keeping `worker/` outside `site/` is structural, not cosmetic: nothing but
`site/` is ever served, so Worker source can never be fetched however the repo
grows later.

---

## Architecture

```
Browser ──▶ Cloudflare Worker
              ├── POST /api/lead        → validate → KV → notify (email, Telegram, Google Sheet)
              ├── GET  /api/lead/status → which channels are configured
              └── everything else       → static assets from ./site
```

One Worker. No server, no database, no build step - the HTML is committed as
built.

The order inside the endpoint is the whole design:

```js
await env.LEADS.put(key, JSON.stringify(record));   // 1. store first
ctx.waitUntil(Promise.all([notifyTelegram(), notifyEmail()]));  // 2. notify, not awaited
return json(200, { ok: true });                     // 3. respond
```

The lead is durable **before** any notification is attempted, and notification
is never awaited. A revoked token, an unverified address or a provider outage
costs a notification, never the enquiry.

### Lead source

Each contact form carries two hidden fields as its first children:

```html
<input type="hidden" name="lead_source" value="PNZ MS Lead">
<input type="hidden" name="Project Name" value="Embassy Chapparkallu">
```

`form-handler.js` sends the second as the lead's project (the Worker prints it as a
`Project:` line) and reads the first into the payload and the Worker stores it on the
record and prints it as a `Source:` line in both the Telegram message and the
email, so enquiries from different campaigns are told apart.

Three places, because both layers whitelist their fields - adding the input
alone would submit nothing:

| Change the value | `value="…"` in the ten pages with a contact form |
| --- | --- |
| Send a different field | `payload` in `site/js/form-handler.js` |
| Store or format it | `LIMITS`, `validate()`, `formatLead()` in `worker/index.js` |

The field is optional at every layer. A page cached before it existed, or
another Webflow export without it, still submits; the `Source:` line is simply
omitted. It is **not** the spam honeypot - that is a separate `company` field
injected by script and never stored. This one is a real submitted value.

Deliberately left without the field: `401.html` (Webflow's password gate, which
posts to `/.wf_auth`) and `style-guide.html` (the component reference page).
Neither produces a lead, and `form-handler.js` skips both.

Every form also carries a hidden Zone field, the project's zone as the PNZ MS
Leads sheet's Project Zone column names it:

```html
<input type="hidden" name="Zone" value="North Bangalore">
```

`form-handler.js` and the pop-up send it as `zone`; the Worker stores it and
prints a `Zone:` line under `Project:` in Telegram and email. A form without
it (a page cached before it was added) gets `SHEET_PROJECT.zone`. The sheet's
Project Zone column is always `SHEET_PROJECT.zone`, the same value, whatever a
form sends.

The zone also routes Telegram, as on every Bangalore microsite: the first bot
posts each lead to the North Bangalore group and to both All Bangalore groups
(`TELEGRAM_ZONE_CHATS` in `worker/index.js`). See Telegram below.

---

## Deploying

Do these in order. Storage and the status endpoint come before any
notification channel, so that when mail misbehaves you can already see what was
captured and what is configured.

### 1. KV namespace

Create it and paste the id into `wrangler.jsonc` (it reads
`REPLACE_WITH_KV_NAMESPACE_ID` until then). Named per project, matching the
other microsites on the account, because a Worker bound to the wrong namespace
would mix two clients' enquiries together.

```sh
npx wrangler kv namespace create embassy-chapparkallu-leads
```

Until a real id is in place `wrangler deploy` fails with
`KV namespace '…' is not valid [code: 10042]` - deliberately. A deploy that
succeeded without storage would put a live form in front of visitors with
nowhere to keep what they send.

### 2. Deploy

Via **Workers → Import a repository**:

- Production branch: this branch
- Build command: **empty** (nothing to build)
- Deploy command: `npx wrangler deploy`

Every push then redeploys. Confirm the site serves before going further.

### 3. Custom domain

**Workers → Settings → Domains & Routes → Add → Custom Domain**, for the apex
**and** `www`. You add no A or CNAME record yourself: Workers custom domains
require the zone on Cloudflare and Cloudflare writes the record.

`embassychapparkallu.com` is already yours and live (on `www`). Point the root domain
at this Worker and redirect `www` to it - every page's canonical points at the root.

### 4. Email

1. **Email Service → Email Routing** → enable for `embassychapparkallu.com`.
   Cloudflare adds MX, SPF and DKIM itself.
2. **Destination Addresses** → add the recipient → **click the verification
   link**. Mail will not send until this is done.

No routing *rule* is needed; those are for receiving. `LEAD_EMAIL_FROM` need not
be a real mailbox - only the domain must be onboarded - but replies to it
bounce, which is why it is `no-reply@`.

Mail to a verified Email Routing destination is free on every plan and counts
against no quota.

### 5. Telegram (optional)

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN   # the bot already in the Bangalore lead groups
```

The chats are fixed in the code, not set as a secret: the North Bangalore group and
both All Bangalore groups (`TELEGRAM_ZONE_CHATS` in `worker/index.js`), as on
every Bangalore microsite, so use the bot that is already a member of those
groups. After deploying, `/api/lead/status?check=telegram` asks Telegram, without
sending anything, whether the bot can post to each group; it answers
`"delivering":true` when all three are fine.

Always choose **Secret**, never a dashboard *Text* variable - plain-text
variables are owned by `wrangler.jsonc` and are wiped by the next deploy.

---

## Google Sheet

Every lead is also added to the shared **PNZ MS Leads** Google Sheet, beside
Telegram and email. Nothing needs setting for it: this Worker holds no URL or
secret. The `LEAD_SHEET` service binding in `wrangler.jsonc` calls the
`LeadSheet` entrypoint of the **assetz-mizu-ki** Worker in the same Cloudflare
account, which holds them and writes the row. `/api/lead/status` reports
`"sheet":{"configured":true}` once deployed.

The row's Page URL column is the full URL (`https://embassychapparkallu.com/price`),
which is how the shared sheet tells this site from the others. Every row also
names the project, the same whatever page or form the lead came from: Project
Name `Embassy Chapparkallu`, City `Bangalore`, Project Zone `North Bangalore`, Project
Status `New Launch`, Project Type `Villas & Apartments` and Project Location
`Chapparkallu Road, Tarahunise` (`SHEET_PROJECT` in `worker/index.js`). Lead City is the visitor's
city, as Cloudflare places them from their IP address: a guide, not an
address. Keep **assetz-mizu-ki** deployed under that
name: if it is ever renamed or deleted, leads here are still stored, emailed
and sent to Telegram, and only the sheet row is missed (the log says
`google sheet append threw`). Problems with the sheet itself are diagnosed
there: `https://assetz-mizu-ki.com/api/lead/status?check=sheet`.

```sh
node worker/sheet.test.mjs   # the sheet channel, no account needed
```

## Verifying

```sh
node worker/test.mjs        # 68 assertions, no account needed
```

After a deploy, through the edge cache - `cf-cache-status: HIT` will otherwise
serve a stale page and make a correct change look broken:

```sh
D=https://embassychapparkallu.com
C=$(date +%s)

curl -s "$D/?cb=$C" | md5sum; md5sum site/index.html   # deployed matches local
curl -s "$D/api/lead/status?cb=$C"                     # which channels are on
```

Then read the logs with `npx wrangler tail`. Every outcome is logged:

| Log line | Cause |
|---|---|
| `lead stored …` | saved to KV - always first |
| `email not configured; no recipient set` | `LEAD_EMAIL_TO` unset |
| `email send failed … not verified` | destination address never verified |
| `telegram config incomplete` | token without chat ids, or the reverse |
| `… status=400 chat not found` | wrong chat id, or Start never pressed |
| `… status=401` | token wrong or revoked |

Read captured leads in the dashboard under **Storage & Databases → KV → leads**.
Keys are `lead:<ISO timestamp>:<id>`, so they sort chronologically. There is
deliberately **no endpoint to read leads back**: an unauthenticated one would
publish every enquirer's name, email and phone number.

---

## Notes

**Recipient address.** `LEAD_EMAIL_TO` sits in `wrangler.jsonc` because this
repository is private. Neither it nor the sender reaches the browser. If the
repo is ever made public, delete that line and
`npx wrangler secret put LEAD_EMAIL_TO` instead - set one or the other, never
both.

**Phone validation is deliberately permissive.** The form is `type="tel"` with
no pattern, so a visitor abroad can type a country code that the browser
accepts. An Indian mobile is normalised to ten digits; any other 8–15 digit
number is kept rather than rejected, because losing an overseas enquiry costs
more than storing an odd number.

**Editing.** Every page is generated from one facts file, so a change to the
copy, a figure or a picture is best made as a rebuild, which carries it to
every page, the schema and the llms files at once. A one-off edit can go
straight into the HTML.

## Contact pop-up

`site/js/contact-popup.js` opens an enquiry form 8 seconds after the visitor
lands, once per browser session (not again on another page or after it is
closed). It closes on X, Esc or a click outside, and is a compact sheet at
the foot of the screen on phones. Its design follows the enquiry dialog on the DSR Ciel and Sri Tirumala
Legacy sites: a native `<dialog>` with name, phone and email, and a button
carrying the same classes as the contact form's.

It is loaded on every page except `401.html` by the small script before
`</body>` that loads jQuery and webflow.js after the first paint (see Speed),
and brings its own markup and styles, so the Webflow markup is untouched.
Leads post to `/api/lead` with the same fields as `form-handler.js`, carrying
the page's own `lead_source` (or `LEAD_SOURCE` on a page without a form) and
a fixed message, since the Worker requires one.

It does not open once this browser has sent a lead, from the pop-up or the
page's own form (`form-handler.js` sets the same flag), over another open
dialog, or while the visitor is typing in a form on the page. `PROJECT`,
`LEAD_SOURCE`, `BUTTON_CLASS` and `DELAY_MS` are at the top of the file. When
re-exporting from Webflow, re-add its `<script>` line along with
`form-handler.js`'s.

## Go-live checklist

`CLAUDE.md` is the standing microsite checklist this site was built and checked
against. What is left once the domain is connected (its phases 6 to 8):

1. Redirect `www.embassychapparkallu.com` to `embassychapparkallu.com` (a Cloudflare Redirect Rule).
2. Telegram: `TELEGRAM_BOT_TOKEN` as a Worker secret, the bot already in the
   Bangalore lead groups; leads go to the North Bangalore group and both All Bangalore
   groups. `/api/lead/status?check=telegram` should answer `"delivering":true`.
3. Email Routing: verify the `LEAD_EMAIL_TO` destination address.
4. Google Search Console, once SSL is active: add the domain property, add the HTML
   tag and the HTML file to the site, then Verify.
5. Submit `sitemap.xml` and confirm it is read without errors.
6. Request indexing (about ten URLs a day): home, overview, FAQs, location, contact,
   then the rest.
7. Live test: submit the contact form and the pop-up, and confirm both reach Telegram
   and email with Project Name, Zone and Source = PNZ MS Lead.
8. Add the site to the tracker sheet under Bangalore, and link it from every other
   Bangalore microsite's "Do you have other projects in Bengaluru?" list.

## Speed

Every page was measured with Lighthouse (the engine behind PageSpeed Insights),
on a phone and a desktop profile, before delivery. Keep these in place when
editing:

- jQuery and webflow.js load after the first paint, from the small script
  before `</body>`, rather than as deferred scripts, which ran before it.
  `form-handler.js` stays deferred, so every form is guarded from the start.
- Pictures carry narrower copies (`-480`, `-720`) in their `srcset`, so a phone
  downloads one that fits, and an AVIF twin is offered first in a `<picture>`, with
  WebP as the fallback.
- The hero picture is fetched first (`fetchpriority="high"`), as is the first
  picture on the gallery page; pictures below the first screen load lazily.
- The photograph bands (the enquiry form and the amenities) are fetched first
  where they open a page (contact-us, amenities), and every phone gets their
  720px copy whatever its pixel density: under the deep wash a sharper
  file would not show.
- The latin files of the fonts the first screen uses are preloaded, and every
  face uses `font-display: swap`.
- Cloudflare compresses the HTML, CSS and JavaScript itself.

## Colour

White pages, a black header, key-figure band, gallery and amenities bands and footer, square `#000000` buttons, `#a64f0a` labels and links, `#f58220` orange and `#e9e2d8` beige on black.

The palette and type are Embassy's own, from embassyindia.com: white and light grey
pages, a black header, bands and footer, square black buttons, warm beige text on
black and its #f58220 orange (deepened to #a64f0a wherever it is text on white, for
contrast). Text is Poppins, the free Google font Embassy's own site falls back to
for its licensed Neulis Sans, light for headings. Every value was contrast-measured
before use.

The Webflow export was built dark, so the palette is repointed at its
source rather than rule by rule: the light-theme block at the end of
`site/css/embassy-chapparkallu.webflow.css` redefines the export's own custom
properties, then overrides only the rules that hard-code a dark
background. Change `--riv-accent` there and every button, label, link,
table stripe and the lettermark follow. The generated tokens still read
`purple` and `gold` because those are Webflow's names; what they resolve
to is set in that block.

Contrast was measured rather than assumed - every rendered text element
across all 13 pages, none below WCAG AA. The favicon and apple-touch
icon are drawn from the same two values.

## Telegram notifications

The Worker posts every lead to Telegram as well as e-mail, routed by zone as on
every Bangalore microsite: to the North Bangalore group and to both All Bangalore
groups, whose chat ids are fixed in `TELEGRAM_ZONE_CHATS` in `worker/index.js`.
Only the token of the bot that is already in those groups is needed, set as a
Worker secret - not as a var in `wrangler.jsonc`, which would put it in the
repository:

```sh
# the argument is the NAME; the value is typed at the prompt
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Then open `/api/lead/status?check=telegram`: it asks Telegram, without sending
anything, whether the bot can post to each group, and answers
`"delivering":true` when it can. A group upgraded to a supergroup gets a new id;
the Worker follows it at once and logs the new id for `TELEGRAM_ZONE_CHATS`.
For local testing put the token in `.dev.vars`, which is already git-ignored.
A second and third bot can be added as `TELEGRAM_BOT_TOKEN_2` /
`TELEGRAM_CHAT_IDS_2` and `_3`; they post to their own chats.
Leads still reach e-mail, KV and the Google Sheet whether or not Telegram is set up.
