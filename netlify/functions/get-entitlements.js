// GET /.netlify/functions/get-entitlements?leadId=...
//
// Frontend pages call this on load instead of trusting only their own
// sessionStorage flags, so a refresh, a back-button, or a returning
// customer on a new tab all see their real purchase state.
const { getEntitlements } = require('./_lib/store');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const leadId = (event.queryStringParameters || {}).leadId;
  if (!leadId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'leadId is required' }) };
  }

  try {
    const e = await getEntitlements(leadId);
    // Only ever hand the frontend the flags it needs to render — never the
    // Stripe customer/payment-method identifiers.
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        paid10: !!e.paid10,
        paid27: !!e.paid27,
        paid97: !!e.paid97,
        purchasedCategory: e.purchasedCategory || null,
        membershipStatus: e.membershipStatus || 'inactive',
        membershipPlan: e.membershipPlan || null,
      }),
    };
  } catch (err) {
    console.error('get-entitlements error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Could not load status.' }) };
  }
};
