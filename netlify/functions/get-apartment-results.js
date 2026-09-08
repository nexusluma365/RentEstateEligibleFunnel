// GET /.netlify/functions/get-apartment-results?leadId=...&category=modern|luxury
//
// Produces personalized apartment results only after the $27 Modern/Luxury
// charge is server-verified. Factual property data comes from Google Places
// when GOOGLE_PLACES_API_KEY is configured. OpenAI is optional and may only
// rank/summarize verified properties; it never creates property facts.
const { getLead, getEntitlements, getApartmentResults, saveApartmentResults } = require('./_lib/store');
const { verify } = require('./_lib/sign');
const { getStripe } = require('./_lib/stripe');

const VALID_CATEGORIES = new Set(['modern', 'luxury']);
const FALLBACK_IMAGES = {
  modern: '/real estate images/charlotte/charlotte.webp',
  luxury: '/real estate images/charlotte/charlotte 1.webp',
};
const MAX_RESULTS = 8;

class GooglePlacesError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GooglePlacesError';
    this.status = status;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const q = event.queryStringParameters || {};
  let leadId = q.leadId;
  let category = (q.category || '').toLowerCase();
  const upsellPaymentIntentId = q.upsellPaymentIntentId || '';
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
    let entitlements = await getEntitlements(leadId);
    if ((!entitlements.paid27 || entitlements.purchasedCategory !== category) && upsellPaymentIntentId) {
      entitlements = await recoverApartmentEntitlement(leadId, category, upsellPaymentIntentId, entitlements);
    }
    if (!entitlements.paid27 || entitlements.purchasedCategory !== category) {
      return json(403, { ok: false, error: 'This apartment list is not unlocked yet.' });
    }

    const lead = await getLead(leadId);
    if (!lead) return json(404, { ok: false, error: 'No saved questionnaire was found.' });

    const criteria = buildCriteria(lead, category);
    const cached = await getApartmentResults(leadId, category);
    if (isUsableCachedResult(cached, criteria)) return json(200, { ok: true, ...cached });

    let rawProperties;
    try {
      rawProperties = await fetchGooglePlaces(criteria);
    } catch (err) {
      if (err instanceof GooglePlacesError) {
        return json(502, {
          ok: false,
          error: err.message,
          provider: 'google_places',
          googleStatus: err.status,
          criteria,
        });
      }
      throw err;
    }
    if (!rawProperties.length) {
      const empty = {
        provider: process.env.GOOGLE_PLACES_API_KEY ? 'google_places' : 'not_configured',
        criteria,
        message: process.env.GOOGLE_PLACES_API_KEY
          ? 'No verified apartment communities were returned for this search. Try a broader city or contact RentReady support.'
          : 'Google Places is not configured yet, so RentReady cannot generate verified apartment recommendations.',
        properties: [],
      };
      await saveApartmentResults(leadId, category, empty);
      return json(200, { ok: true, leadId, category, generatedAt: new Date().toISOString(), ...empty });
    }

    const properties = await rankWithOpenAI(rawProperties, criteria);
    const result = { provider: 'google_places', message: null, criteria, properties };
    await saveApartmentResults(leadId, category, result);
    return json(200, { ok: true, leadId, category, generatedAt: new Date().toISOString(), ...result });
  } catch (err) {
    console.error('get-apartment-results error', err);
    return json(500, { ok: false, error: 'Could not load apartment results right now.' });
  }
};

async function recoverApartmentEntitlement(leadId, category, paymentIntentId, current) {
  let pi;
  try {
    pi = await getStripe().paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    console.warn('apartment entitlement recovery lookup failed', err.code || err.message);
    return current;
  }

  const metadata = pi.metadata || {};
  if (pi.status !== 'succeeded' || metadata.leadId !== leadId || metadata.product !== category) {
    return current;
  }

  const patch = { paid27: true, purchasedCategory: category };
  if (pi.customer) patch.stripeCustomerId = pi.customer;
  if (pi.payment_method) patch.defaultPaymentMethodId = pi.payment_method;

  try {
    const { patchEntitlements } = require('./_lib/store');
    return await patchEntitlements(leadId, patch);
  } catch (err) {
    console.error('apartment entitlement recovery save failed', err);
    return { ...current, ...patch, leadId };
  }
}

async function fetchGooglePlaces(criteria) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const resultsByPlaceId = new Map();
  for (const query of googlePlaceQueries(criteria)) {
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    url.searchParams.set('query', query);
    // NOTE: intentionally no `type` param. Google's `type` filter is a hard
    // restriction, not a relevance hint, and apartment communities are almost
    // never tagged `real_estate_agency` (that type is for leasing/realtor
    // offices). Setting it here silently filtered out nearly every real
    // apartment complex. The query text itself ("apartments in <city>",
    // "apartment communities in <city>") already steers Text Search toward
    // the right category.
    url.searchParams.set('key', key);

    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    assertGooglePlacesResponse(data);
    const results = Array.isArray(data.results) ? data.results : [];
    results.forEach((place) => {
      if (place.place_id && !resultsByPlaceId.has(place.place_id)) {
        resultsByPlaceId.set(place.place_id, place);
      }
    });
    if (results.length) break;
    if (resultsByPlaceId.size >= MAX_RESULTS) break;
  }

  const results = Array.from(resultsByPlaceId.values()).slice(0, MAX_RESULTS);
  const details = await Promise.all(results.map((p) => fetchPlaceDetails(p.place_id, key)));

  return results.map((p, index) => normalizePlace(p, details[index], criteria, key)).filter((p) => p.propertyId && p.name);
}

function googlePlaceQueries(criteria) {
  const category = criteria.category === 'luxury' ? 'luxury' : 'modern';
  const bedroomText = criteria.bedroomsLabel ? `${criteria.bedroomsLabel} ` : '';
  const city = criteria.city;
  return [
    `${category} ${bedroomText}apartments in ${city}`,
    `${category} apartment communities in ${city}`,
    `${bedroomText}apartments for rent in ${city}`,
    `apartment communities in ${city}`,
  ];
}

function assertGooglePlacesResponse(data) {
  const status = data && data.status;
  if (!status || status === 'OK' || status === 'ZERO_RESULTS') return;

  const googleMessage = data.error_message ? ` ${data.error_message}` : '';
  const setupStatuses = new Set(['REQUEST_DENIED', 'INVALID_REQUEST', 'OVER_QUERY_LIMIT']);
  const message = setupStatuses.has(status)
    ? `Google Places is not returning apartment results because of a Google Maps API setup issue: ${status}.${googleMessage}`
    : `Google Places returned ${status}.${googleMessage}`;
  throw new GooglePlacesError(message.trim(), status);
}

async function fetchPlaceDetails(placeId, key) {
  if (!placeId) return null;
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'name,formatted_address,formatted_phone_number,international_phone_number,website,url,rating,user_ratings_total,photo,types,business_status');
  url.searchParams.set('key', key);

  try {
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    return data && data.result ? data.result : null;
  } catch (err) {
    console.warn('place details lookup failed', err.message || err);
    return null;
  }
}

function normalizePlace(place, details, criteria, key) {
  const source = details || {};
  const photoRef =
    (source.photos && source.photos[0] && source.photos[0].photo_reference) ||
    (place.photos && place.photos[0] && place.photos[0].photo_reference);
  const property = {
    propertyId: place.place_id || '',
    name: source.name || place.name || '',
    address: source.formatted_address || place.formatted_address || '',
    phone: source.formatted_phone_number || source.international_phone_number || '',
    website: source.website || '',
    image: photoUrl(photoRef, key) || FALLBACK_IMAGES[criteria.category],
    rating: typeof source.rating === 'number' ? source.rating : typeof place.rating === 'number' ? place.rating : null,
    reviewCount:
      typeof source.user_ratings_total === 'number'
        ? source.user_ratings_total
        : typeof place.user_ratings_total === 'number'
        ? place.user_ratings_total
        : null,
    directions:
      source.url ||
      (place.place_id ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(place.place_id)}` : ''),
    category: criteria.category,
    businessStatus: source.business_status || place.business_status || '',
    source: 'Google Places',
  };
  return { ...property, ...scoreProperty(property, criteria) };
}

function photoUrl(ref, key) {
  if (!ref) return '';
  const url = new URL('https://maps.googleapis.com/maps/api/place/photo');
  url.searchParams.set('maxwidth', '900');
  url.searchParams.set('photo_reference', ref);
  url.searchParams.set('key', key);
  return url.toString();
}

async function rankWithOpenAI(properties, criteria) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return defaultRank(properties, criteria);

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
              category: criteria.category,
              preferences: criteria,
              properties: properties.map(({ propertyId, name, address, rating, reviewCount, phone, website }) => ({
                propertyId,
                name,
                address,
                rating,
                reviewCount,
                hasPhone: !!phone,
                hasWebsite: !!website,
              })),
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
    return defaultRank(properties, criteria)
      .map((p) => enrich(p, byId.get(p.propertyId)))
      .sort((a, b) => b.matchScore - a.matchScore);
  } catch (err) {
    console.error('OpenAI ranking fallback', err.message || err);
    return defaultRank(properties, criteria);
  }
}

function defaultRank(properties, criteria) {
  return properties
    .map((p) => (p.matchReasons && p.matchReasons.length && p.summary ? p : { ...p, ...scoreProperty(p, criteria) }))
    .sort((a, b) => b.matchScore - a.matchScore);
}

function isUsableCachedResult(cached, criteria) {
  if (!cached || cached.provider !== 'google_places') return false;
  if (!cached.criteria || cached.criteria.category !== criteria.category || cached.criteria.city !== criteria.city) return false;
  if (Number(cached.criteria.rentBudget || 0) !== Number(criteria.rentBudget || 0)) return false;
  if (Number(cached.criteria.bedrooms ?? -1) !== Number(criteria.bedrooms ?? -1)) return false;
  const properties = Array.isArray(cached.properties) ? cached.properties : [];
  if (!properties.length) return false;
  return properties.every((property) => {
    const website = String(property.website || '');
    const phone = String(property.phone || '');
    return !website.includes('example.com') && !/555-0\d{3}|555\d{4}/.test(phone);
  });
}

function buildCriteria(lead, category) {
  const city = clean(lead.preferred_city || lead.city) || 'United States';
  const rentBudget = Number(lead.rent_budget) || null;
  const bedrooms = normalizeBedrooms(lead.beds_needed);
  return {
    category,
    city,
    rentBudget,
    bedrooms,
    bedroomsLabel: bedroomLabel(bedrooms),
    moveTimeline: clean(lead.move_timeline),
    moveReason: clean(lead.move_reason),
  };
}

function normalizeBedrooms(value) {
  const raw = String(value || '').split(',')[0].trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'studio') return 0;
  if (raw.includes('4')) return 4;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : null;
}

function bedroomLabel(bedrooms) {
  if (bedrooms === null || bedrooms === undefined) return '';
  if (bedrooms === 0) return 'studio';
  if (bedrooms >= 4) return '4 bedroom';
  return `${bedrooms} bedroom`;
}

function scoreProperty(property, criteria) {
  let score = 58;
  const text = `${property.name} ${property.address}`.toLowerCase();
  const cityTerms = clean(criteria.city)
    .toLowerCase()
    .split(/[,\s]+/)
    .filter((term) => term.length > 2);
  const cityHits = cityTerms.filter((term) => text.includes(term)).length;
  if (cityTerms.length && cityHits) score += Math.min(18, cityHits * 7);

  if (criteria.category === 'luxury') {
    if (/\bluxury|residences|reserve|retreat|lofts|collection|villas|heights|park|pointe/.test(text)) score += 13;
  } else if (/\bmodern|lofts|flats|studio|urban|new|contemporary|station|square/.test(text)) {
    score += 13;
  }

  if (typeof property.rating === 'number') score += Math.max(0, Math.min(12, Math.round((property.rating - 3.4) * 8)));
  if (property.phone) score += 4;
  if (property.website) score += 4;
  if (property.businessStatus === 'OPERATIONAL') score += 3;
  if (criteria.rentBudget && criteria.rentBudget < 1800) score += text.includes('luxury') ? 1 : 4;
  score = Math.max(55, Math.min(98, Math.round(score)));

  const matchReasons = [
    `Searched for ${criteria.category} apartments in ${criteria.city}`,
    criteria.rentBudget
      ? `Matched against your target budget around $${criteria.rentBudget}/mo`
      : 'Matched against your saved RentReady search profile',
    criteria.bedroomsLabel ? `Bedroom preference: ${criteria.bedroomsLabel}` : 'Bedroom preference included when available',
    property.phone || property.website ? 'Contact details found through Google Places' : 'Verified through Google Places',
  ];

  return {
    matchScore: score,
    matchReasons,
    summary:
      'This verified apartment community is a strong candidate for your saved search. Contact the property to confirm current rent, availability, move-in specials, deposits, lease terms, and screening requirements.',
    availabilityNote: 'Google Places does not publish live unit availability. Call or visit the property website to confirm current openings.',
  };
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
