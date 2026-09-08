// POST /.netlify/functions/create-payment-intent
// Body: { leadId, email, answers }
//
// This is the ONLY place a customer ever types card details. It creates a
// Stripe Customer (or reuses one already tied to this leadId), and a
// PaymentIntent for $10 with `setup_future_usage: 'off_session'` so the
// same card can be charged again later for the $27 upsell without asking for
// it again.
const { getStripe } = require('./_lib/stripe');
const { saveLead, patchEntitlements } = require('./_lib/store');

const PRESCREEN_AMOUNT_CENTS = 1000;

async function findCustomerByLeadId(stripe, leadId) {
  try {
    const existing = await stripe.customers.search({
      query: `metadata['leadId']:'${leadId.replace(/'/g, '')}'`,
      limit: 1,
    });
    return existing.data[0] || null;
  } catch (err) {
    // A search issue should not stop a fresh checkout from starting. Creating
    // a new customer is safer than blocking the $10 PaymentIntent.
    console.warn('customer search failed, creating a new customer', err);
    return null;
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

  const { leadId, email, answers } = body;
  const normalizedLeadId = String(leadId || '').trim();
  if (!normalizedLeadId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'leadId is required' }) };
  }

  try {
    const stripe = getStripe();

    // Reuse an existing Stripe Customer for this leadId if one exists
    // (e.g. the customer refreshed the page after the intent was created
    // but before paying), otherwise create a new one.
    const existing = await findCustomerByLeadId(stripe, normalizedLeadId);
    const customer =
      existing ||
      (await stripe.customers.create({
        email: email || undefined,
        metadata: { leadId: normalizedLeadId },
      }));

    const paymentIntent = await stripe.paymentIntents.create({
      amount: PRESCREEN_AMOUNT_CENTS,
      currency: 'usd',
      customer: customer.id,
      setup_future_usage: 'off_session',
      payment_method_types: ['card'],
      metadata: { leadId: normalizedLeadId, product: 'prescreen' },
    });

    // Save the questionnaire answers server-side so later functions (PDF
    // generation, the $97 relevance check, email delivery) have an
    // authoritative copy instead of trusting whatever the browser sends.
    try {
      if (answers) {
        await saveLead(normalizedLeadId, answers);
      }
      await patchEntitlements(normalizedLeadId, { stripeCustomerId: customer.id });
    } catch (err) {
      console.warn('pre-payment lead save failed', err);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      }),
    };
  } catch (err) {
    console.error('create-payment-intent error', err);
    const message = err && err.message ? err.message : '';
    const setupError =
      message.includes('STRIPE_SECRET_KEY') ||
      message.includes('Invalid API Key') ||
      message.includes('No API key provided');

    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: setupError ? message : 'Could not start checkout.',
      }),
    };
  }
};
