// GET /.netlify/functions/get-apartment-results?leadId=...&category=modern|luxury
//
// Produces personalized apartment results only after the $27 Modern/Luxury
// charge is server-verified. Factual property data comes from Google Places
// when GOOGLE_PLACES_API_KEY is configured. OpenAI is optional and may only
// rank/summarize verified properties; it never creates property facts.
const { getLead, getEntitlements, getApartmentResults, saveApartmentResults } = require('./_lib/store');
const { verify } = require('./_lib/sign');

const VALID_CATEGORIES = new Set(['modern', 'luxury']);
const FALLBACK_IMAGES = {
  modern: '/real estate images/charlotte/charlotte.webp',
  luxury: '/real estate images/charlotte/charlotte 1.webp',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const q = event.queryStringParameters || {};
  let leadId = q.leadId;
  let category = (q.category || '').toLowerCase();
  if (q.token) {
    const data = verify(q.token);
    if (!data || data.product !== 'apartment-results') {
      return json(403, { ok: false, error: 'This link has expired. Request a new one from the site.' });
    }
    leadId = data.leadId;
    category = data.category;
  }
  if (!leadId || !VALID_CATEGORIES.has(category)) {
    return json(400, { ok: false, error: 'Missing or invalid fields' });
  }

  try {
    const entitlements = await getEntitlements(leadId);
    if (!entitlements.paid27 || entitlements.purchasedCategory !== category) {
      return json(403, { ok: false, error: 'This apartment list is not unlocked yet.' });
    }

    const cached = await getApartmentResults(leadId, category);
    if (cached) return json(200, { ok: true, ...cached });

    const lead = await getLead(leadId);
    if (!lead) return json(404, { ok: false, error: 'No saved questionnaire was found.' });

    const rawProperties = await fetchGooglePlaces(lead, category);
    if (!rawProperties.length) {
      const empty = {
        provider: process.env.GOOGLE_PLACES_API_KEY ? 'google_places' : 'not_configured',
        message: process.env.GOOGLE_PLACES_API_KEY
          ? 'No verified apartment communities were returned for this search. Try a broader city or contact RentReady support.'
          : 'Google Places is not configured yet, so RentReady cannot generate verified apartment recommendations.',
        properties: [],
      };
      await saveApartmentResults(leadId, category, empty);
      return json(200, { ok: true, leadId, category, generatedAt: new Date().toISOString(), ...empty });
    }

    const properties = await rankWithOpenAI(rawProperties, lead, category);
    const result = { provider: 'google_places', message: null, properties };
    await saveApartmentResults(leadId, category, result);
    return json(200, { ok: true, leadId, category, generatedAt: new Date().toISOString(), ...result });
  } catch (err) {
    console.error('get-apartment-results error', err);
    return json(500, { ok: false, error: 'Could not load apartment results right now.' });
  }
};

async function fetchGooglePlaces(lead, category) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const city = clean(lead.preferred_city) || 'United States';
  const query = `${category === 'luxury' ? 'luxury apartments' : 'modern apartments'} in ${city}`;
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
  url.searchParams.set('query', query);
  url.searchParams.set('type', 'real_estate_agency');
  url.searchParams.set('key', key);

  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  const results = Array.isArray(data.results) ? data.results.slice(0, 8) : [];

  return results.map((p) => ({
    propertyId: p.place_id || '',
    name: p.name || '',
    address: p.formatted_address || '',
    phone: '',
    website: '',
    image: photoUrl(p.photos && p.photos[0] && p.photos[0].photo_reference, key) || FALLBACK_IMAGES[category],
    rating: typeof p.rating === 'number' ? p.rating : null,
    directions: p.place_id ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(p.place_id)}` : '',
    category,
    matchScore: 0,
    matchReasons: [],
    summary: '',
    source: 'Google Places',
  })).filter((p) => p.propertyId && p.name);
}

function photoUrl(ref, key) {
  if (!ref) return '';
  const url = new URL('https://maps.googleapis.com/maps/api/place/photo');
  url.searchParams.set('maxwidth', '900');
  url.searchParams.set('photo_reference', ref);
  url.searchParams.set('key', key);
  return url.toString();
}

async function rankWithOpenAI(properties, lead, category) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return defaultRank(properties, lead, category);

  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        input: [
          {
            role: 'system',
            content: 'Rank verified apartment communities for rental preference fit. Do not invent factual fields. Return strict JSON with a properties array. Use only propertyId to identify items.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              category,
              preferences: {
                city: lead.preferred_city || '',
                rentBudget: lead.rent_budget || '',
                moveTimeline: lead.move_timeline || '',
                bedrooms: lead.beds_needed || '',
                moveReason: lead.move_reason || '',
              },
              properties: properties.map(({ propertyId, name, address, rating }) => ({ propertyId, name, address, rating })),
            }),
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'apartment_ranking',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                properties: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      propertyId: { type: 'string' },
                      matchScore: { type: 'number' },
                      matchReasons: { type: 'array', items: { type: 'string' } },
                      summary: { type: 'string' },
                    },
                    required: ['propertyId', 'matchScore', 'matchReasons', 'summary'],
                  },
                },
              },
              required: ['properties'],
            },
          },
        },
      }),
    });

    const data = await resp.json();
    const text = data.output_text || (((data.output || [])[0] || {}).content || [])[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    const byId = new Map((parsed && parsed.properties ? parsed.properties : []).map((p) => [p.propertyId, p]));
    return defaultRank(properties, lead, category)
      .map((p) => enrich(p, byId.get(p.propertyId)))
      .sort((a, b) => b.matchScore - a.matchScore);
  } catch (err) {
    console.error('OpenAI ranking fallback', err.message || err);
    return defaultRank(properties, lead, category);
  }
}

function defaultRank(properties, lead, category) {
  return properties.map((p, index) => ({
    ...p,
    matchScore: Math.max(70, 94 - index * 4),
    matchReasons: [
      `Located around ${clean(lead.preferred_city) || 'your selected area'}`,
      category === 'luxury' ? 'Matches your luxury apartment selection' : 'Matches your modern apartment selection',
      'Verified through Google Places',
    ],
    summary: 'This verified apartment community may be worth contacting to confirm current rent, availability, deposits, lease terms, and screening requirements.',
  }));
}

function enrich(property, ai) {
  if (!ai) return property;
  return {
    ...property,
    matchScore: boundedNumber(ai.matchScore, property.matchScore),
    matchReasons: Array.isArray(ai.matchReasons) ? ai.matchReasons.slice(0, 4).map(String) : property.matchReasons,
    summary: typeof ai.summary === 'string' && ai.summary.trim() ? ai.summary.trim() : property.summary,
  };
}

function boundedNumber(n, fallback) {
  const value = Number(n);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function clean(value) {
  return String(value || '').trim();
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) };
}
