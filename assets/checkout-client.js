/*
 * RentReady checkout client — shared by every page AFTER the $10
 * pre-screen (game-plan.html, credit-action-package.html, membership.html).
 * The $10 page itself uses Stripe's Payment Element directly (it's the
 * only place a card is ever typed), which is wired inline in
 * the result pages rather than here.
 *
 * This file does not render or style anything — it only calls the
 * Netlify Functions backend and reports back a small set of states so
 * each page's own markup (already styled to match the rest of the site)
 * can react to them.
 */
(() => {
const ANSWERS_KEY = 'rrn_answers_v1';
const FLOW_ACCESS_KEY = 'rrn_flow_access_v1';
const PRESCREEN_INTENT_KEY = 'rrn_prescreen_payment_intent_v1';
const FLOW_ACCESS_TTL_MS = 20 * 60 * 1000;
let rrnConfigPromise = null;

function rrnLeadId() {
  try {
    const a = JSON.parse(sessionStorage.getItem(ANSWERS_KEY) || 'null');
    return (a && a.lead_id) || null;
  } catch (_e) {
    return null;
  }
}

function rrnFlowAccess() {
  try { return JSON.parse(sessionStorage.getItem(FLOW_ACCESS_KEY) || 'null'); }
  catch (_e) { return null; }
}

function rrnGrantFlowAccess(step, details) {
  try {
    sessionStorage.setItem(FLOW_ACCESS_KEY, JSON.stringify({
      step,
      status: details && details.status ? details.status : 'confirmed',
      category: details && details.category ? details.category : null,
      city: details && details.city ? details.city : null,
      at: Date.now(),
    }));
  } catch (_e) {}
}

function rrnHasRecentFlowAccess(step, options) {
  const access = rrnFlowAccess();
  if (!access || access.step !== step) return false;
  if (!access.at || Date.now() - access.at > FLOW_ACCESS_TTL_MS) return false;
  if (options && options.statuses && !options.statuses.includes(access.status)) return false;
  if (options && options.category && access.category !== options.category) return false;
  return true;
}

function rrnNewIdempotencyKey() {
  return (crypto.randomUUID ? crypto.randomUUID() : ('k_' + Date.now() + '_' + Math.random().toString(36).slice(2)));
}

function rrnPrescreenPaymentIntentId() {
  try {
    return sessionStorage.getItem(PRESCREEN_INTENT_KEY) || localStorage.getItem(PRESCREEN_INTENT_KEY) || null;
  } catch (_e) {
    return null;
  }
}

async function rrnLoadStripeJs() {
  if (window.Stripe) return window.Stripe;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return window.Stripe;
}

async function rrnGetConfig() {
  if (!rrnConfigPromise) {
    rrnConfigPromise = fetch('/.netlify/functions/config')
      .then((res) => res.ok ? res.json() : null)
      .catch(() => null);
  }
  return await rrnConfigPromise;
}

async function rrnGetStripePublishableKey(fallbackKey) {
  const cleanFallback = fallbackKey && !String(fallbackKey).includes('PASTE_YOUR')
    ? String(fallbackKey)
    : '';
  const config = await rrnGetConfig();
  return (config && config.stripePublishableKey) || cleanFallback;
}

async function rrnFetchEntitlements(leadId) {
  const res = await fetch('/.netlify/functions/get-entitlements?leadId=' + encodeURIComponent(leadId));
  if (!res.ok) return null;
  const data = await res.json();
  return data.ok ? data : null;
}

/**
 * Runs the full one-click purchase for a $27/$97 product, including
 * transparently handling a bank's 3-D Secure challenge if Stripe requires
 * one. Resolves to one of: 'succeeded' | 'failed' | 'processing'.
 */
async function rrnChargeUpsell(product, publishableKey) {
  const leadId = rrnLeadId();
  if (!leadId) return 'failed';

  const idempotencyKey = rrnNewIdempotencyKey();
  const res = await fetch('/.netlify/functions/charge-upsell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, product, idempotencyKey, prescreenPaymentIntentId: rrnPrescreenPaymentIntentId() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || !data.ok) return 'failed';

  if (data.status === 'requires_action') {
    const stripeKey = await rrnGetStripePublishableKey(publishableKey);
    return await rrnHandleAction(data.clientSecret, leadId, product, stripeKey);
  }
  return data.status; // 'succeeded' | 'failed' | 'processing'
}

/**
 * Same idea as rrnChargeUpsell, for the RentReady Support subscription.
 */
async function rrnCreateSubscription(plan, publishableKey) {
  const leadId = rrnLeadId();
  if (!leadId) return 'failed';

  const idempotencyKey = rrnNewIdempotencyKey();
  const res = await fetch('/.netlify/functions/create-subscription', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, plan, idempotencyKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || !data.ok) return 'failed';

  if (data.status === 'requires_action') {
    const Stripe = await rrnLoadStripeJs();
    const stripeKey = await rrnGetStripePublishableKey(publishableKey);
    const stripe = Stripe(stripeKey);
    const result = await stripe.confirmCardPayment(data.clientSecret);
    if (result.error) return 'failed';
    const confirmRes = await fetch('/.netlify/functions/confirm-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId, subscriptionId: data.subscriptionId, plan }),
    });
    const confirmData = await confirmRes.json().catch(() => ({}));
    return confirmData && confirmData.ok ? confirmData.status : 'failed';
  }
  return data.status;
}

async function rrnHandleAction(clientSecret, leadId, product, publishableKey) {
  const Stripe = await rrnLoadStripeJs();
  const stripe = Stripe(publishableKey);
  const result = await stripe.confirmCardPayment(clientSecret);
  if (result.error) return 'failed';

  const stripeSucceeded = result.paymentIntent && result.paymentIntent.status === 'succeeded';
  try {
    const confirmRes = await fetch('/.netlify/functions/confirm-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId, paymentIntentId: result.paymentIntent.id, product }),
    });
    const confirmData = await confirmRes.json().catch(() => ({}));
    return confirmData && confirmData.ok ? confirmData.status : (stripeSucceeded ? 'succeeded' : 'failed');
  } catch (_e) {
    return stripeSucceeded ? 'succeeded' : 'failed';
  }
}

function rrnDownloadUrl(product) {
  const leadId = rrnLeadId();
  return '/.netlify/functions/download-file?leadId=' + encodeURIComponent(leadId) + '&product=' + encodeURIComponent(product);
}

async function rrnEmailAsset(type, category) {
  const leadId = rrnLeadId();
  if (!leadId) return false;
  const res = await fetch('/.netlify/functions/email-asset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, type, category }),
  });
  const data = await res.json().catch(() => ({}));
  return !!(data && data.ok);
}

window.rrnLeadId = rrnLeadId;
window.rrnNewIdempotencyKey = rrnNewIdempotencyKey;
window.rrnPrescreenPaymentIntentId = rrnPrescreenPaymentIntentId;
window.rrnLoadStripeJs = rrnLoadStripeJs;
window.rrnGetConfig = rrnGetConfig;
window.rrnGetStripePublishableKey = rrnGetStripePublishableKey;
window.rrnFetchEntitlements = rrnFetchEntitlements;
window.rrnChargeUpsell = rrnChargeUpsell;
window.rrnCreateSubscription = rrnCreateSubscription;
window.rrnDownloadUrl = rrnDownloadUrl;
window.rrnEmailAsset = rrnEmailAsset;
window.rrnGrantFlowAccess = rrnGrantFlowAccess;
window.rrnHasRecentFlowAccess = rrnHasRecentFlowAccess;
})();
