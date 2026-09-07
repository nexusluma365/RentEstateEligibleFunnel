exports.handler = async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { Allow: 'GET' },
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';

  return {
    statusCode: stripePublishableKey ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok: !!stripePublishableKey,
      stripePublishableKey,
      error: stripePublishableKey ? null : 'STRIPE_PUBLISHABLE_KEY is not configured.',
    }),
  };
};
