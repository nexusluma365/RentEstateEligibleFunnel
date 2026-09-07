// Short-lived signed tokens for the links we email customers, so a link
// that goes out in an email isn't a permanently public URL. Requires the
// EMAIL_LINK_SECRET environment variable (any long random string).
const crypto = require('crypto');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function secret() {
  const s = process.env.EMAIL_LINK_SECRET;
  if (!s) throw new Error('EMAIL_LINK_SECRET is not set.');
  return s;
}

function sign(payloadObj, ttlMs = DEFAULT_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const body = Buffer.from(JSON.stringify({ ...payloadObj, exp })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

module.exports = { sign, verify };
