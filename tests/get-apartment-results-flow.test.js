const assert = require('assert');

async function loadHandler({ lead, entitlements, cached, upsellIntent, patchEntitlements }) {
  const storePath = require.resolve('../netlify/functions/_lib/store');
  const signPath = require.resolve('../netlify/functions/_lib/sign');
  const stripePath = require.resolve('../netlify/functions/_lib/stripe');
  const fnPath = require.resolve('../netlify/functions/get-apartment-results');
  delete require.cache[fnPath];

  const savedResults = [];
  const retrieveCalls = [];
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      getLead: async () => lead,
      getEntitlements: async () => entitlements,
      getApartmentResults: async () => cached || null,
      saveApartmentResults: async (leadId, category, results) => savedResults.push({ leadId, category, results }),
      patchEntitlements: patchEntitlements || (async (leadId, patch) => ({ ...entitlements, ...patch, leadId })),
    },
  };
  require.cache[signPath] = {
    id: signPath,
    filename: signPath,
    loaded: true,
    exports: { verify: () => null },
  };
  require.cache[stripePath] = {
    id: stripePath,
    filename: stripePath,
    loaded: true,
    exports: {
      getStripe: () => ({
        paymentIntents: {
          retrieve: async (id) => {
            retrieveCalls.push(id);
            return upsellIntent;
          },
        },
      }),
    },
  };

  return { handler: require('../netlify/functions/get-apartment-results').handler, savedResults, retrieveCalls };
}

async function run() {
  const oldFetch = global.fetch;
  const oldGoogleKey = process.env.GOOGLE_PLACES_API_KEY;
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const urls = [];
  process.env.GOOGLE_PLACES_API_KEY = 'google_test_key';
  delete process.env.OPENAI_API_KEY;

  global.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/textsearch/')) {
      const parsed = new URL(String(url));
      const query = parsed.searchParams.get('query');
      assert.match(query, /luxury|modern/i);
      assert.match(query, /1600/);
      assert.match(query, /concord/i);
      return {
        json: async () => ({
          results: [
            {
              place_id: 'place_concord_1',
              name: 'Concord Reserve Apartments',
              formatted_address: '1600 Concord Pkwy, Concord, NC',
              rating: 4.6,
              user_ratings_total: 88,
              business_status: 'OPERATIONAL',
            },
          ],
        }),
      };
    }
    if (String(url).includes('/details/')) {
      return {
        json: async () => ({
          result: {
            name: 'Concord Reserve Apartments',
            formatted_address: '1600 Concord Pkwy, Concord, NC',
            formatted_phone_number: '(704) 555-0199',
            website: 'https://example.com/concord-reserve',
            url: 'https://maps.google.com/?cid=concordreserve',
            rating: 4.7,
            user_ratings_total: 91,
            business_status: 'OPERATIONAL',
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const { handler, savedResults } = await loadHandler({
      lead: {
        preferred_city: 'Concord, NC',
        rent_budget: 1600,
        beds_needed: '1',
        move_timeline: 'asap',
      },
      entitlements: {
        paid27: true,
        purchasedCategory: 'luxury',
      },
      cached: {
        provider: 'google_places',
        criteria: { category: 'luxury', city: 'Concord, NC', rentBudget: 1600, bedrooms: 1 },
        properties: [
          {
            propertyId: 'old_demo',
            name: 'Skyline House Uptown',
            phone: '(704) 555-0188',
            website: 'https://example.com/skyline-house',
          },
        ],
      },
    });

    const res = await handler({
      httpMethod: 'GET',
      queryStringParameters: { leadId: 'lead_123', category: 'luxury' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.provider, 'google_places');
    assert.equal(body.criteria.city, 'Concord, NC');
    assert.equal(body.criteria.rentBudget, 1600);
    assert.equal(body.properties.length, 1);
    assert.equal(body.properties[0].name, 'Concord Reserve Apartments');
    assert.equal(body.properties[0].phone, '(704) 555-0199');
    assert.equal(body.properties[0].website, 'https://example.com/concord-reserve');
    assert.match(body.properties[0].availabilityNote, /availability/i);
    assert.equal(savedResults.length, 1);
    assert(urls.some((url) => url.includes('/textsearch/')));
    assert(urls.some((url) => url.includes('/details/')));

    urls.length = 0;
    const recovery = await loadHandler({
      lead: {
        preferred_city: 'Concord, NC',
        rent_budget: 1600,
        beds_needed: '1',
      },
      entitlements: {
        paid27: false,
        purchasedCategory: null,
      },
      upsellIntent: {
        id: 'pi_modern_upsell',
        status: 'succeeded',
        metadata: { leadId: 'lead_123', product: 'modern', category: 'modern' },
        customer: 'cus_test',
        payment_method: 'pm_test',
      },
    });
    const recoveryRes = await recovery.handler({
      httpMethod: 'GET',
      queryStringParameters: {
        leadId: 'lead_123',
        category: 'modern',
        upsellPaymentIntentId: 'pi_modern_upsell',
      },
    });
    const recoveryBody = JSON.parse(recoveryRes.body);

    assert.equal(recoveryRes.statusCode, 200);
    assert.equal(recoveryBody.ok, true);
    assert.equal(recoveryBody.criteria.category, 'modern');
    assert.deepEqual(recovery.retrieveCalls, ['pi_modern_upsell']);
  } finally {
    global.fetch = oldFetch;
    if (oldGoogleKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldGoogleKey;
    if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAIKey;
  }
}

run()
  .then(() => console.log('get-apartment-results flow test passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
