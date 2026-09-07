// POST /.netlify/functions/join-waiting-list
// Body: { leadId, category }
const { getLead, saveWaitingListEntry } = require('./_lib/store');

const VALID_CATEGORIES = new Set(['modern', 'luxury']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_e) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const leadId = body.leadId;
  const category = String(body.category || '').toLowerCase();
  if (!leadId || !VALID_CATEGORIES.has(category)) {
    return json(400, { ok: false, error: 'Missing or invalid fields' });
  }

  try {
    const lead = await getLead(leadId);
    if (!lead || !lead.email) {
      return json(404, { ok: false, error: 'No saved questionnaire was found for this session.' });
    }

    await saveWaitingListEntry({
      leadId,
      email: lead.email,
      category,
      selectedCity: lead.preferred_city || '',
      timestamp: new Date().toISOString(),
    });

    return json(200, { ok: true });
  } catch (err) {
    console.error('join-waiting-list error', err);
    return json(500, { ok: false, error: 'Could not join the waiting list right now.' });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) };
}
