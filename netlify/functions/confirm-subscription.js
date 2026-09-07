// POST /.netlify/functions/confirm-subscription
// Body: { leadId, subscriptionId, plan }
//
// Called after stripe.confirmCardPayment() resolves client-side for a
// subscription's first invoice that required 3D Secure. Re-checks with
// Stripe directly before granting membership access.
const { getStripe } = require('./_lib/stripe');
const { patchEntitlements } = require('./_lib/store');

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

  const { leadId, subscriptionId, plan } = body;
  if (!leadId || !subscriptionId || !plan) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing fields' }) };
  }

  try {
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent'],
    });

    if (subscription.metadata.leadId !== leadId) {
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Lead mismatch' }) };
    }

    const pi = subscription.latest_invoice && subscription.latest_invoice.payment_intent;

    if (subscription.status === 'active' || (pi && pi.status === 'succeeded')) {
      await patchEntitlements(leadId, {
        membershipStatus: 'active',
        membershipPlan: plan,
        stripeSubscriptionId: subscription.id,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'succeeded' }) };
    }

    if (pi && pi.status === 'requires_action') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'requires_action', clientSecret: pi.client_secret }) };
    }

    try {
      await stripe.subscriptions.cancel(subscription.id);
    } catch (_e) {
      /* best effort */
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'failed' }) };
  } catch (err) {
    console.error('confirm-subscription error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Could not confirm membership.' }) };
  }
};
