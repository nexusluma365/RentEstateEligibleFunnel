const assert = require('assert');

function loadHandler() {
  const storePath = require.resolve('../netlify/functions/_lib/store');
  const fnPath = require.resolve('../netlify/functions/submit-lead');
  delete require.cache[fnPath];

  const savedLeads = [];
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      saveLead: async (leadId, answers) => savedLeads.push({ leadId, answers }),
    },
  };

  return { handler: require('../netlify/functions/submit-lead').handler, savedLeads };
}

async function run() {
  const oldGoogleUrl = process.env.GOOGLE_SCRIPT_URL;
  const oldFetch = global.fetch;

  try {
    delete process.env.GOOGLE_SCRIPT_URL;
    const missingSheets = loadHandler();
    const missingSheetsRes = await missingSheets.handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        lead_id: 'lead_123',
        email: 'renter@example.com',
        preferred_city: 'High Point, NC',
      }),
    });
    const missingSheetsBody = JSON.parse(missingSheetsRes.body);

    assert.equal(missingSheetsRes.statusCode, 200);
    assert.equal(missingSheetsBody.ok, false);
    assert.equal(missingSheetsBody.saved, true);
    assert.equal(missingSheetsBody.sheetsOk, false);
    assert.equal(missingSheets.savedLeads.length, 1);
    assert.equal(missingSheets.savedLeads[0].leadId, 'lead_123');
    assert.equal(missingSheets.savedLeads[0].answers.preferred_city, 'High Point, NC');

    process.env.GOOGLE_SCRIPT_URL = 'https://script.google.test/exec';
    const forwarded = loadHandler();
    let forwardedPayload = null;
    global.fetch = async (url, options) => {
      assert.equal(url, process.env.GOOGLE_SCRIPT_URL);
      forwardedPayload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ ok: true, row: 42 }),
        text: async () => JSON.stringify({ ok: true, row: 42 }),
      };
    };

    const forwardedRes = await forwarded.handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        lead_id: 'lead_456',
        email: 'second@example.com',
      }),
    });
    const forwardedBody = JSON.parse(forwardedRes.body);

    assert.equal(forwardedRes.statusCode, 200);
    assert.equal(forwardedBody.ok, true);
    assert.equal(forwardedBody.saved, true);
    assert.equal(forwardedBody.sheetsOk, true);
    assert.equal(forwarded.savedLeads.length, 1);
    assert.equal(forwarded.savedLeads[0].leadId, 'lead_456');
    assert.equal(forwardedPayload.lead_id, 'lead_456');
  } finally {
    if (oldGoogleUrl === undefined) delete process.env.GOOGLE_SCRIPT_URL;
    else process.env.GOOGLE_SCRIPT_URL = oldGoogleUrl;
    global.fetch = oldFetch;
  }
}

run()
  .then(() => console.log('submit-lead flow test passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
