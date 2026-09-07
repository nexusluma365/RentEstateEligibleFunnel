// Server-side storage using Netlify Blobs. This is the ONE source of truth
// for what a customer has actually paid for — the frontend never decides
// entitlement on its own, it only asks these stores.
//
// Three logical stores, all backed by Netlify Blobs:
//   "leads"        — the questionnaire answers, saved server-side the
//                     moment we create the $10 PaymentIntent, so every
//                     later function can trust the answers instead of
//                     re-trusting whatever the browser sends.
//   "entitlements" — { paid10, paid27, paid97, membershipStatus,
//                     membershipPlan, stripeCustomerId,
//                     defaultPaymentMethodId, ... } keyed by leadId.
//                     Only stripe-webhook.js and the *-upsell/subscription
//                     functions (after Stripe itself confirms a charge)
//                     are allowed to write here.
//
// Netlify Blobs requires no separate account/setup beyond having the site
// deployed on Netlify — it's provisioned automatically. See SETUP_PAYMENTS.md.
const { getStore } = require('@netlify/blobs');
const fs = require('fs/promises');
const path = require('path');

class LocalBlobStore {
  constructor(name) {
    this.dir = path.join(process.cwd(), '.netlify-local-blobs', name);
  }

  fileFor(key) {
    return path.join(this.dir, encodeURIComponent(key));
  }

  async get(key, opts = {}) {
    try {
      const bytes = await fs.readFile(this.fileFor(key));
      if (opts.type === 'json') {
        return JSON.parse(bytes.toString('utf8'));
      }
      if (opts.type === 'arrayBuffer') {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      return bytes.toString('utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async setJSON(key, value) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.fileFor(key), JSON.stringify(value, null, 2));
  }
}

function createStore(name) {
  try {
    return getStore(name);
  } catch (err) {
    if (err && err.name === 'MissingBlobsEnvironmentError') {
      return new LocalBlobStore(name);
    }
    throw err;
  }
}

function leadsStore() {
  return createStore('rrn-leads');
}
function entitlementsStore() {
  return createStore('rrn-entitlements');
}
function filesStore() {
  return createStore('rrn-files');
}
function apartmentResultsStore() {
  return createStore('rrn-apartment-results');
}
function waitingListStore() {
  return createStore('rrn-waiting-list');
}

async function saveLead(leadId, answers) {
  await leadsStore().setJSON(leadId, answers);
}

async function getLead(leadId) {
  return leadsStore().get(leadId, { type: 'json' });
}

async function getEntitlements(leadId) {
  const rec = await entitlementsStore().get(leadId, { type: 'json' });
  return (
    rec || {
      leadId,
      paid10: false,
      paid27: false,
      paid97: false,
      membershipStatus: 'inactive',
      membershipPlan: null,
      stripeCustomerId: null,
      defaultPaymentMethodId: null,
    }
  );
}

async function patchEntitlements(leadId, patch) {
  const current = await getEntitlements(leadId);
  const next = { ...current, ...patch, leadId };
  await entitlementsStore().setJSON(leadId, next);
  return next;
}

async function getProtectedFile(product) {
  // product is 'gameplan' or 'creditkit'. Upload the real PDFs once with
  // the small script documented in SETUP_PAYMENTS.md — this just reads
  // whatever bytes are stored under that key. Nothing here is a public URL.
  return filesStore().get(product, { type: 'arrayBuffer' });
}

async function saveApartmentResults(leadId, category, results) {
  const key = `${leadId}:${category}`;
  await apartmentResultsStore().setJSON(key, {
    leadId,
    category,
    generatedAt: new Date().toISOString(),
    ...results,
  });
}

async function getApartmentResults(leadId, category) {
  return apartmentResultsStore().get(`${leadId}:${category}`, { type: 'json' });
}

async function saveWaitingListEntry(entry) {
  const key = `${entry.leadId || 'unknown'}:${entry.category || 'unknown'}:${Date.now()}`;
  await waitingListStore().setJSON(key, entry);
  return key;
}

module.exports = {
  saveLead,
  getLead,
  getEntitlements,
  patchEntitlements,
  getProtectedFile,
  saveApartmentResults,
  getApartmentResults,
  saveWaitingListEntry,
};
