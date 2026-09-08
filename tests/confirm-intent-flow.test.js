const assert = require('assert');

async function loadHandler({ paymentIntent, patchEntitlements, customerUpdate }) {
  const stripePath = require.resolve('../netlify/functions/_lib/stripe');
  const storePath = require.resolve('../netlify/functions/_lib/store');
  const fnPath = require.resolve('../netlify/functions/confirm-intent');
  delete require.cache[fnPath];

  require.cache[stripePath] = {
    id: stripePath,
    filename: stripePath,
    loaded: true,
    exports: {
      getStripe: () => ({
        paymentIntents: {
          retrieve: async () => paymentIntent,
        },
        customers: {
          update: customerUpdate || (async () => ({})),
        },
      }),
    },
  };
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: { patchEntitlements },
  };

  return require('../netlify/functions/confirm-intent').handler;
}

async function run() {
  const succeededIntent = {
    id: 'pi_test',
    status: 'succeeded',
    metadata: { leadId: 'lead_123' },
    customer: 'cus_test',
    payment_method: 'pm_test',
  };

  const handler = await loadHandler({
    paymentIntent: succeededIntent,
    patchEntitlements: async () => {
      throw new Error('temporary entitlement write failure');
    },
    customerUpdate: async () => {
      throw new Error('temporary customer update failure');
    },
  });

  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      leadId: 'lead_123',
      paymentIntentId: 'pi_test',
      product: 'prescreen',
    }),
  });
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'succeeded');
  assert.match(body.warning, /could not be saved/i);

  const mismatchHandler = await loadHandler({
    paymentIntent: { ...succeededIntent, metadata: { leadId: 'other_lead' } },
    patchEntitlements: async () => ({}),
  });
  const mismatchRes = await mismatchHandler({
    httpMethod: 'POST',
    body: JSON.stringify({
      leadId: 'lead_123',
      paymentIntentId: 'pi_test',
      product: 'prescreen',
    }),
  });
  assert.equal(mismatchRes.statusCode, 403);
}

run()
  .then(() => console.log('confirm-intent flow test passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
