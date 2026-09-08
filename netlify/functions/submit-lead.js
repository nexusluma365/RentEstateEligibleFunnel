const { saveLead } = require('./_lib/store');

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { Allow: 'POST' },
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch (_err) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Invalid JSON payload.' }),
    };
  }

  const leadId = String(payload.lead_id || payload.leadId || '').trim();
  if (!leadId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'lead_id is required.' }),
    };
  }

  try {
    await saveLead(leadId, { ...payload, lead_id: leadId });
  } catch (err) {
    console.error('lead save failed', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Could not save questionnaire.' }),
    };
  }

  const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL || '';
  if (!googleScriptUrl) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        saved: true,
        sheetsOk: false,
        error: 'GOOGLE_SCRIPT_URL is not configured.',
      }),
    };
  }

  try {
    const res = await fetch(googleScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_err) { data = { ok: res.ok, raw: text }; }

    const sheetsOk = !!(res.ok && data && data.ok !== false);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: sheetsOk,
        saved: true,
        sheetsOk,
        sheets: data,
        error: sheetsOk ? undefined : 'Google Sheets did not accept the lead.',
      }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        saved: true,
        sheetsOk: false,
        error: String(err && err.message ? err.message : err),
      }),
    };
  }
};
