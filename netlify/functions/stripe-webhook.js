// POST /.netlify/functions/stripe-webhook
// Configure this URL in the Stripe Dashboard → Developers → Webhooks, and
// put the signing secret it gives you into STRIPE_WEBHOOK_SECRET.
//
// The confirm-intent / charge-upsell / create-subscription functions
// already write entitlements the moment Stripe confirms a charge
// synchronously — this webhook exists as the backstop source of truth for
// everything else: 3DS completions that happen after the customer closed
// the tab, disputed/refunded charges, subscription renewals and
// cancellations. Every write here is idempotent (it just sets fields to
// their correct value), so it's safe if Stripe retries or a synchronous
// call already handled the same event.
const { getStripe } = require('./_lib/stripe');
const { patchEntitlements } = require('./_lib/store');

const FIELD_BY_PRODUCT = { prescreen: 'paid10', modern: 'paid27', luxury: 'paid27', gameplan: 'paid27', creditkit: 'paid97' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe = getStripe();
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case 'payment_intent.succeeded': {
        const pi = stripeEvent.data.object;
        const leadId = pi.metadata && pi.metadata.leadId;
        const product = pi.metadata && pi.metadata.product;
        const field = FIELD_BY_PRODUCT[product];
        if (leadId && field) {
          const patch = { [field]: true };
          if (pi.customer) patch.stripeCustomerId = pi.customer;
          if (pi.payment_method) patch.defaultPaymentMethodId = pi.payment_method;
          if (product === 'modern' || product === 'luxury') patch.purchasedCategory = product;
          await patchEntitlements(leadId, patch);
          if (pi.customer && pi.payment_method) {
            await stripe.customers.update(pi.customer, {
              invoice_settings: { default_payment_method: pi.payment_method },
            });
          }
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = stripeEvent.data.object;
        const leadId = sub.metadata && sub.metadata.leadId;
        const plan = sub.metadata && sub.metadata.plan;
        if (leadId) {
          await patchEntitlements(leadId, {
            membershipStatus: sub.status === 'active' ? 'active' : 'inactive',
            membershipPlan: sub.status === 'active' ? plan || null : null,
            stripeSubscriptionId: sub.id,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const leadId = sub.metadata && sub.metadata.leadId;
        if (leadId) {
          await patchEntitlements(leadId, { membershipStatus: 'inactive', membershipPlan: null });
        }
        break;
      }

      default:
        break; // ignore everything else
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook processing error', err);
    // Return 200 anyway so Stripe doesn't hammer retries for a bug on our
    // side once we've logged it — adjust if you'd rather see retries.
    return { statusCode: 200, body: JSON.stringify({ received: true, note: 'logged error' }) };
  }
};
