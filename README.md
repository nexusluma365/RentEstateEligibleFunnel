# RentReady Network

Static RentReady funnel pages hosted on Netlify, with Netlify Functions for lead capture, Stripe saved-card payments, entitlement checks, secure downloads, email delivery, and apartment-list generation.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local env file from `.env.example` if you want to test functions locally:

```bash
cp .env.example .env
```

3. Run locally with Netlify:

```bash
npm run dev
```

## Netlify Deploy

1. Push this folder to GitHub.
2. In Netlify, create a new site from that GitHub repo.
3. Use these build settings:

```text
Build command: leave empty
Publish directory: .
Functions directory: netlify/functions
```

4. Add the environment variables below in Netlify:

```text
STRIPE_PUBLISHABLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_MONTHLY
STRIPE_PRICE_ANNUAL
EMAIL_LINK_SECRET
GOOGLE_SCRIPT_URL
GOOGLE_PLACES_API_KEY
OPENAI_API_KEY
OPENAI_MODEL
```

`OPENAI_MODEL` is optional. If it is not set, the apartment-results function uses its default model.

After the first deploy, add the Stripe webhook endpoint:

```text
https://YOUR_NETLIFY_DOMAIN/.netlify/functions/stripe-webhook
```

Send these Stripe events: `payment_intent.succeeded`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`.

## Production Flow

The public lead form submits through `/.netlify/functions/submit-lead`, so the Google Apps Script URL stays in Netlify env instead of the HTML.

Paid pages call Netlify Functions before unlocking protected steps. Direct URL access to payment-confirmed pages is guarded by server-side entitlement checks plus short-lived same-session handoff markers for the active checkout flow.

The luxury and modern apartment upsells both charge through the saved Stripe customer payment method. If the upsell succeeds, the packet email is sent and the user continues to `Real-estate list.html`. If the card is declined, the user still continues to the listings page but no packet email is sent.
