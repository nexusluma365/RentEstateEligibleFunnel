# Setting up the real payment backend

This pass replaced the old Stripe Payment Link setup with a real backend:
Netlify Functions + Stripe's server-side API, so the $10 pre-screen is the
only place a card is ever typed, and every step after it is a genuine
one-click charge against the saved payment method — server-verified, not
just a frontend flag.

```
Questionnaire → $10 Pre-Screen (card entered once)
              → Results
              → $27 Modern/Luxury List   (one click, saved card)
              → Verified apartment results + email delivery
              → $27 Game Plan            (legacy one click, saved card)
              → $97 Credit Action Kit    (one click, only when relevant)
              → $297/yr or $35/mo Support (one click, real subscription)
              → Thank You
```

## 1) Install dependencies

```
npm install
```

This pulls in `stripe`, `@netlify/blobs`, and `pdf-lib` for the functions
in `/netlify/functions`.

## 2) Environment variables (Netlify → Site settings → Environment variables)

| Variable | Where to get it |
|---|---|
| `STRIPE_PUBLISHABLE_KEY` | Stripe Dashboard → Developers → API keys. Public key served to the browser by `/.netlify/functions/config`. |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys. **Secret key — server only, never in frontend code.** |
| `STRIPE_WEBHOOK_SECRET` | Created in step 4 below. |
| `STRIPE_PRICE_MONTHLY` | A **recurring** Stripe Price, $35/month (Dashboard → Product catalog → create the RentReady Support product, add a monthly recurring price). |
| `STRIPE_PRICE_ANNUAL` | Same product, a second recurring price, $297/year. |
| `EMAIL_LINK_SECRET` | Any long random string (e.g. `openssl rand -hex 32`). Signs the time-limited links that go out in emails. |
| `GOOGLE_SCRIPT_URL` | The Apps Script web app URL. It is used server-side by lead capture and email delivery functions, and is no longer hardcoded into public HTML. |
| `GOOGLE_PLACES_API_KEY` | Google Maps Platform API key with Places API enabled. Required for verified Modern/Luxury apartment recommendations. Without it, the app will not invent apartment communities. |
| `OPENAI_API_KEY` | Optional. Used server-side only to rank/summarize verified Google Places properties. |
| `OPENAI_MODEL` | Optional. Defaults to `gpt-4.1-mini` for apartment ranking. |

Netlify Blobs (used for entitlements, saved answers, and the two protected
PDFs) needs no separate setup or account — it's provisioned automatically
for any site deployed on Netlify.

## 3) Keep keys in Netlify

Do not paste Stripe or Google keys into HTML files. The frontend asks
`/.netlify/functions/config` for the Stripe publishable key, and lead capture
posts through `/.netlify/functions/submit-lead`, which forwards to Apps Script
using the private `GOOGLE_SCRIPT_URL` environment variable.

## 4) Create the Stripe webhook

1. Deploy the site to Netlify first (the webhook needs a real URL).
2. Stripe Dashboard → Developers → Webhooks → **Add endpoint**.
3. Endpoint URL: `https://YOURDOMAIN/.netlify/functions/stripe-webhook`
4. Events to send: `payment_intent.succeeded`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
5. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

This webhook is the backstop source of truth — the functions also write
entitlements synchronously the moment Stripe confirms a charge, so the
webhook mainly matters for 3-D-Secure completions that happen after the
customer closes the tab, and for subscription renewals/cancellations.

## 5) Redeploy the Google Apps Script

`google-apps-script/code.gs` now handles a second action, `sendEmail`,
alongside the existing lead-capture logic (which is untouched). In the
Apps Script editor: **Deploy → Manage deployments → Edit → New version →
Deploy.** The web app URL stays the same, so nothing else needs updating
besides `GOOGLE_SCRIPT_URL` in step 2.

## 6) Upload the two protected PDFs

The $27 Game Plan and $97 Credit Action Kit are real files a customer
downloads after paying — there's no public URL for them anywhere in the
site; `download-file.js` only serves them after checking the server-side
entitlement. Upload the actual PDFs once with the Netlify CLI:

```
npm install -g netlify-cli
netlify login
netlify blobs:set rrn-files gameplan  --input ./RentReady-Game-Plan.pdf  --site YOUR_SITE_ID
netlify blobs:set rrn-files creditkit --input ./RentReady-Credit-Action-Kit.pdf --site YOUR_SITE_ID
```

Until these are uploaded, a successful $27/$97 purchase still grants
entitlement correctly — the download link will just return a clear
"hasn't been uploaded yet" message instead of a file.

## 7) Test with Stripe test mode

Use Stripe's test keys and these card numbers on the $10 Payment Element:

| Card | Behavior |
|---|---|
| `4242 4242 4242 4242` | Succeeds immediately, no 3DS. |
| `4000 0025 0000 3155` | Requires 3-D Secure — confirms the `requires_action` handling on every step. |
| `4000 0000 0000 9995` | Always declines — confirms the "we couldn't complete this purchase" + "Continue Without This" path. |
| `4000 0000 0000 0341` | Succeeds on the $10 charge, then the *saved* card fails on later off-session charges — the most realistic test of the $27/$97/membership decline path. |

Any future date for expiry, any 3 digits for CVC, any ZIP.

You can also use the Stripe CLI to forward webhooks to a local dev server:
`stripe listen --forward-to localhost:8888/.netlify/functions/stripe-webhook`

## What to verify end-to-end

This mirrors the test list from the funnel spec:

- [ ] $10 Payment Element charges successfully and saves the card
- [ ] Result renders immediately after payment, no upsell shown yet
- [ ] Download My Results produces a PDF containing only the $10-tier content
- [ ] Email My Results sends a working, time-limited link
- [ ] $27 Game Plan one-click succeeds with the saved card (no card form appears)
- [ ] Modern/Luxury option cards route to the premium page with the selected category
- [ ] $27 Modern/Luxury one-click succeeds with the saved card (no card form appears)
- [ ] Successful Modern/Luxury purchase renders Google Places-backed apartment results
- [ ] Apartment result email sends a signed, time-limited results link
- [ ] Modern/Luxury decline shows the short redirect message, continues to listings, and does not email the packet
- [ ] $27 decline shows the message, then fades in "Continue Without This →"
- [ ] $27 3DS card triggers the challenge and still completes correctly
- [ ] $97 only appears when the questionnaire answers indicate a credit issue
- [ ] $97 is rejected server-side (400) if attempted directly for a non-relevant profile
- [ ] $97 success/decline/3DS mirror the $27 behavior
- [ ] Monthly and yearly membership both create real Stripe Subscriptions
- [ ] Subscription decline shows the message and routes to Thank You
- [ ] Refreshing or hitting back on any page after payment still shows the correct (paid) state, via `get-entitlements`
- [ ] Rapid double-clicking a purchase button never creates two charges (idempotency key + button lock)
- [ ] Thank You page's message matches whatever was actually purchased — never claims something was emailed that wasn't
- [ ] A manually edited `sessionStorage` flag cannot unlock a download — only a real server-side entitlement can

## What changed in this pass

**Kept exactly as-is:** the questionnaire (`index.html` /
`renter-lead-form.html`), all page structure/CSS/typography/cards/buttons
across every page, the lead-capture half of `code.gs`, and
`results-processing.html`.

**Added:**
- `/netlify/functions/*` — the real backend (Stripe PaymentIntents/
  Subscriptions, entitlements via Netlify Blobs, protected file delivery,
  server-generated result PDF, email delivery).
- `/assets/checkout-client.js` — shared frontend logic for the one-click
  purchase/3DS/entitlement calls used by `game-plan.html`,
  `credit-action-package.html`, and `membership.html`. Purely behavioral —
  it doesn't style or render anything.
- Server-guarded access checks and the unlocked result experience on
  `After Payment Results.html`.
- Real one-click purchase buttons, `requires_action` (3DS) handling, and
  the "we couldn't complete this purchase" → fade-in "Continue Without
  This →" pattern on `game-plan.html`, `credit-action-package.html`, and
  `membership.html`.
- `Luxury Apartment Upsell.html` and `Modern Apartment Upsell.html` — saved-card
  $27 apartment upsells that redirect to `Real-estate list.html` after payment
  succeeds or after the decline notice is shown.
- `/netlify/functions/get-apartment-results.js` — fetches factual property
  data from Google Places and optionally uses OpenAI server-side for ranking
  only. It returns no invented communities if Places is not configured.
- `/netlify/functions/join-waiting-list.js` — stores declined/opt-in waiting
  list entries in Netlify Blobs.
- `thank-you.html` — final page, message and download links driven by the
  customer's actual server-verified purchase state.
- `sendEmail` action added to `google-apps-script/code.gs`.
- `package.json`, and `netlify.toml` updated to build the functions.
