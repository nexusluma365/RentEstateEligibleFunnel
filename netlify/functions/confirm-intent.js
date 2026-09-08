// POST /.netlify/functions/confirm-intent
// Body: { leadId, paymentIntentId, product }   product: 'prescreen'|'modern'|'luxury'|'gameplan'|'creditkit'
//
// The frontend never gets to just SAY a payment succeeded — this function
// re-fetches the PaymentIntent from Stripe itself and only grants
// entitlement if Stripe confirms it. It's used right after the $10
// Payment Element confirms client-side, and again after a customer
// completes a 3D Secure challenge on a later step.
const { getStripe } = require('./_lib/stripe');
const { patchEntitlements } = require('./_lib/store');

const FIELD_BY_PRODUCT = { prescreen: 'paid10', modern: 'paid27', luxury: 'paid27', gameplan: 'paid27', creditkit: 'paid97' };

function setupErrorMessage(err) {
  const message = err && err.message ? err.message : '';
  if (
    message.includes('STRIPE_SECRET_KEY') ||
    message.includes('Invalid API Key') ||
    message.includes('No API key provided')
  ) {
    return message;
  }
  return '';
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

  const { leadId, paymentIntentId, product } = body;
  const field = FIELD_BY_PRODUCT[product];
  if (!leadId || !paymentIntentId || !field) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing or invalid fields' }) };
  }

  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (pi.metadata.leadId !== leadId) {
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Lead mismatch' }) };
    }

    if (pi.status === 'succeeded') {
      const patch = { [field]: true };
      if (pi.customer) patch.stripeCustomerId = pi.customer;
      if (pi.payment_method) patch.defaultPaymentMethodId = pi.payment_method;
      if (product === 'modern' || product === 'luxury') patch.purchasedCategory = product;
      let entitlements = null;
      let entitlementWarning = null;

      try {
        entitlements = await patchEntitlements(leadId, patch);
      } catch (err) {
        entitlementWarning = 'Payment succeeded, but access status could not be saved immediately.';
        console.error('confirm-intent entitlement patch error', err);
      }

      // Make sure the customer's default payment method is set, so
      // subscriptions created later automatically use the right card.
      if (pi.customer && pi.payment_method) {
        try {
          await stripe.customers.update(pi.customer, {
            invoice_settings: { default_payment_method: pi.payment_method },
          });
        } catch (err) {
          console.error('confirm-intent customer update error', err);
        }
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'succeeded', entitlements, warning: entitlementWarning }) };
    }

    if (pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, status: 'requires_action', clientSecret: pi.client_secret }),
      };
    }

    if (pi.status === 'processing') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'processing' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'failed' }) };
  } catch (err) {
    console.error('confirm-intent error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: setupErrorMessage(err) || 'Could not confirm payment.' }) };
  }
};
