const assert = require('assert');

async function loadHandler({ entitlements, prescreenIntent, upsellIntent, patchEntitlements }) {
  const stripePath = require.resolve('../netlify/functions/_lib/stripe');
  const storePath = require.resolve('../netlify/functions/_lib/store');
  const focusPath = require.resolve('../netlify/functions/_lib/focus');
  const fnPath = require.resolve('../netlify/functions/charge-upsell');
  delete require.cache[fnPath];

  const retrieveCalls = [];
  const createCalls = [];

  require.cache[stripePath] = {
    id: stripePath,
    filename: stripePath,
    loaded: true,
    exports: {
      getStripe: () => ({
        paymentIntents: {
          retrieve: async (id) => {
            retrieveCalls.push(id);
            return prescreenIntent;
          },
          create: async (payload) => {
            createCalls.push(payload);
            return upsellIntent;
          },
        },
      }),
    },
  };

  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      getEntitlements: async () => entitlements,
      getLead: async () => ({ credit_score: '700_739' }),
      patchEntitlements,
    },
  };

  require.cache[focusPath] = {
    id: focusPath,
    filename: focusPath,
    loaded: true,
    exports: { determineFocus: () => 'income' },
  };

  const handler = require('../netlify/functions/charge-upsell').handler;
  return { handler, retrieveCalls, createCalls };
}

async function run() {
  const patchCalls = [];
  const { handler, retrieveCalls, createCalls } = await loadHandler({
    entitlements: {
      leadId: 'lead_123',
      paid10: false,
      paid27: false,
      paid97: false,
      stripeCustomerId: null,
      defaultPaymentMethodId: null,
    },
    prescreenIntent: {
      id: 'pi_prescreen',
      status: 'succeeded',
      metadata: { leadId: 'lead_123', product: 'prescreen' },
      customer: 'cus_test',
      payment_method: 'pm_test',
    },
    upsellIntent: { id: 'pi_upsell', status: 'succeeded' },
    patchEntitlements: async (leadId, patch) => {
      patchCalls.push({ leadId, patch });
      return { leadId, paid10: true, ...patch };
    },
  });

  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      leadId: 'lead_123',
      product: 'modern',
      idempotencyKey: 'idem_123',
      prescreenPaymentIntentId: 'pi_prescreen',
    }),
  });
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'succeeded');
  assert.deepEqual(retrieveCalls, ['pi_prescreen']);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].amount, 2700);
  assert.equal(createCalls[0].customer, 'cus_test');
  assert.equal(createCalls[0].payment_method, 'pm_test');
  assert.equal(patchCalls.length, 2);
  assert.deepEqual(patchCalls[0].patch, {
    paid10: true,
    stripeCustomerId: 'cus_test',
    defaultPaymentMethodId: 'pm_test',
  });
  assert.deepEqual(patchCalls[1].patch, {
    paid27: true,
    purchasedCategory: 'modern',
  });

  const mismatch = await loadHandler({
    entitlements: {
      leadId: 'lead_123',
      paid10: false,
      paid27: false,
      paid97: false,
      stripeCustomerId: null,
      defaultPaymentMethodId: null,
    },
    prescreenIntent: {
      id: 'pi_other',
      status: 'succeeded',
      metadata: { leadId: 'other_lead', product: 'prescreen' },
      customer: 'cus_test',
      payment_method: 'pm_test',
    },
    upsellIntent: { id: 'pi_upsell', status: 'succeeded' },
    patchEntitlements: async () => ({}),
  });
  const mismatchRes = await mismatch.handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      leadId: 'lead_123',
      product: 'modern',
      idempotencyKey: 'idem_123',
      prescreenPaymentIntentId: 'pi_other',
    }),
  });
  assert.equal(mismatchRes.statusCode, 403);
  assert.equal(mismatch.createCalls.length, 0);
}

run()
  .then(() => console.log('charge-upsell flow test passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
