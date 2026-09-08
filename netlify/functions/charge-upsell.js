// POST /.netlify/functions/charge-upsell
// Body: { leadId, product, idempotencyKey }   product: 'modern'|'luxury'|'gameplan'|'creditkit'
//
// This is the actual "one click" purchase: no card form, no redirect —
// it charges the payment method saved during the $10 pre-screen. It only
// runs when the customer presses the disclosed-price button on the page;
// nothing here fires on page load, scroll, or navigation.
const { getStripe } = require('./_lib/stripe');
const { getEntitlements, getLead, patchEntitlements } = require('./_lib/store');
const { determineFocus } = require('./_lib/focus');

const PRODUCTS = {
  gameplan: { amount: 2700, field: 'paid27', label: 'RentReady Game Plan' },
  modern: { amount: 2700, field: 'paid27', label: 'RentReady Modern Apartment Matches & RentReady Guide', category: 'modern' },
  luxury: { amount: 2700, field: 'paid27', label: 'RentReady Luxury Apartment Matches & RentReady Guide', category: 'luxury' },
  creditkit: { amount: 9700, field: 'paid97', label: 'RentReady Credit Action Kit' },
};

async function recoverPrescreenEntitlements(stripe, leadId, prescreenPaymentIntentId, current) {
  if (!prescreenPaymentIntentId) return current;
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(prescreenPaymentIntentId);
  } catch (err) {
    console.warn('charge-upsell prescreen recovery lookup failed', err.code || err.message);
    return current;
  }
  const metadata = pi.metadata || {};
  if (metadata.leadId !== leadId || metadata.product !== 'prescreen' || pi.status !== 'succeeded') {
    return current;
  }
  if (!pi.customer || !pi.payment_method) return current;

  const patch = {
    paid10: true,
    stripeCustomerId: pi.customer,
    defaultPaymentMethodId: pi.payment_method,
  };

  try {
    return await patchEntitlements(leadId, patch);
  } catch (err) {
    console.error('charge-upsell prescreen recovery save error', err);
    return { ...current, ...patch, leadId };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { leadId, product, idempotencyKey, prescreenPaymentIntentId } = body;
  const def = PRODUCTS[product];
  if (!leadId || !def || !idempotencyKey) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing or invalid fields' }) };
  }

  try {
    let entitlements = await getEntitlements(leadId);
    const stripe = getStripe();

    if (!entitlements.paid10 || !entitlements.stripeCustomerId || !entitlements.defaultPaymentMethodId) {
      entitlements = await recoverPrescreenEntitlements(stripe, leadId, prescreenPaymentIntentId, entitlements);
    }

    if (!entitlements.paid10 || !entitlements.stripeCustomerId || !entitlements.defaultPaymentMethodId) {
      return {
        statusCode: 403,
        body: JSON.stringify({ ok: false, error: 'Complete the $10 pre-screen before this step.' }),
      };
    }

    // Already-purchased is a no-op success, not a second charge.
    if (entitlements[def.field] && (!def.category || entitlements.purchasedCategory === def.category)) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'succeeded', alreadyOwned: true }) };
    }

    // Server-side relevance guard for the conditional $97 offer — a
    // customer can't unlock it just by hitting this endpoint if their own
    // answers don't indicate a credit/history issue worth reviewing.
    if (product === 'creditkit') {
      const lead = await getLead(leadId);
      if (!lead || determineFocus(lead) !== 'credit') {
        return {
          statusCode: 400,
          body: JSON.stringify({ ok: false, error: 'This offer is not relevant to your results.' }),
        };
      }
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: def.amount,
          currency: 'usd',
          customer: entitlements.stripeCustomerId,
          payment_method: entitlements.defaultPaymentMethodId,
          off_session: true,
          confirm: true,
          metadata: { leadId, product, category: def.category || '' },
        },
        { idempotencyKey: `${leadId}:${product}:${idempotencyKey}` }
      );
    } catch (err) {
      if (err.code === 'authentication_required' && err.raw && err.raw.payment_intent) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            ok: true,
            status: 'requires_action',
            clientSecret: err.raw.payment_intent.client_secret,
            paymentIntentId: err.raw.payment_intent.id,
          }),
        };
      }
      console.error('charge-upsell decline', err.code || err.message);
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, status: 'failed', message: 'We couldn\u2019t complete this purchase with your saved payment method.' }),
      };
    }

    if (pi.status === 'succeeded') {
      const patch = { [def.field]: true };
      if (def.category) patch.purchasedCategory = def.category;
      let warning = null;
      try {
        await patchEntitlements(leadId, patch);
      } catch (err) {
        warning = 'Purchase succeeded, but access status could not be saved immediately.';
        console.error('charge-upsell entitlement patch error', err);
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'succeeded', warning }) };
    }

    if (pi.status === 'requires_action') {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, status: 'requires_action', clientSecret: pi.client_secret, paymentIntentId: pi.id }),
      };
    }

    if (pi.status === 'processing') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'processing', paymentIntentId: pi.id }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'failed' }) };
  } catch (err) {
    console.error('charge-upsell error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Could not process this purchase.' }) };
  }
};
