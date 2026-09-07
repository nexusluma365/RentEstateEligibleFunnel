// Shared Stripe client for all functions.
// Requires the STRIPE_SECRET_KEY environment variable to be set in the
// Netlify dashboard (Site settings → Environment variables). Never commit
// a real secret key to source control.
const Stripe = require('stripe');

let _stripe = null;

function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it in Netlify → Site settings → ' +
      'Environment variables, then redeploy.'
    );
  }
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

module.exports = { getStripe };
