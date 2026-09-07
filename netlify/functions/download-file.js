// GET /.netlify/functions/download-file?leadId=...&product=gameplan|creditkit
//   or  ?token=...   (a signed link from an email — see _lib/sign.js)
//
// There is no public Cloudflare/S3 URL for these files anywhere in the
// site. The only way to get the bytes is through this function, which
// checks the server-side entitlement (written only by Stripe-confirmed
// events) before it will read anything out of storage.
const { getEntitlements, getProtectedFile } = require('./_lib/store');
const { verify } = require('./_lib/sign');

const FIELD_BY_PRODUCT = { gameplan: 'paid27', creditkit: 'paid97' };
const FILENAME_BY_PRODUCT = {
  gameplan: 'RentReady-Game-Plan.pdf',
  creditkit: 'RentReady-Credit-Action-Kit.pdf',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const q = event.queryStringParameters || {};
  let leadId = q.leadId;
  let product = q.product;

  if (q.token) {
    const data = verify(q.token);
    if (!data) {
      return { statusCode: 403, body: 'This link has expired. Request a new one from the site.' };
    }
    leadId = data.leadId;
    product = data.product;
  }

  const field = FIELD_BY_PRODUCT[product];
  if (!leadId || !field) {
    return { statusCode: 400, body: 'Missing or invalid product.' };
  }

  try {
    const entitlements = await getEntitlements(leadId);
    if (!entitlements[field]) {
      return { statusCode: 403, body: 'This file is not unlocked for this account yet.' };
    }

    const fileBytes = await getProtectedFile(product);
    if (!fileBytes) {
      return {
        statusCode: 404,
        body: `The ${product} PDF hasn't been uploaded to storage yet — see SETUP_PAYMENTS.md.`,
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${FILENAME_BY_PRODUCT[product]}"`,
        'Cache-Control': 'private, no-store',
      },
      isBase64Encoded: true,
      body: Buffer.from(fileBytes).toString('base64'),
    };
  } catch (err) {
    console.error('download-file error', err);
    return { statusCode: 500, body: 'Could not deliver the file right now.' };
  }
};
