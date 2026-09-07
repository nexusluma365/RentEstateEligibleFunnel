// GET /.netlify/functions/download-result-pdf?leadId=...   (or ?token=...)
//
// Builds the $10 pre-screen result as a PDF on demand from the answers we
// saved server-side at checkout time — never from whatever the browser
// currently has in sessionStorage, so this can't be tampered with client
// side. Deliberately contains ONLY what the $10 pre-screen promised — no
// Game Plan, no Credit Action Kit, no membership content.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { getEntitlements, getLead } = require('./_lib/store');
const { verify } = require('./_lib/sign');
const { creditTier, incomeMeetsBenchmark } = require('./_lib/focus');

const TIMELINE_LABELS = {
  asap: 'ASAP',
  '1_month': 'within 1 month',
  '3_months': 'in 1\u20133 months',
  '6_months': 'in 3\u20136 months',
  flexible: 'on a flexible timeline',
};
const CREDIT_LABELS = {
  below_580: 'Below 580',
  '580_619': '580\u2013619',
  '620_659': '620\u2013659',
  '660_699': '660\u2013699',
  '700_739': '700\u2013739',
  '740_799': '740\u2013799',
  '800_plus': '800+',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const q = event.queryStringParameters || {};
  let leadId = q.leadId;

  if (q.token) {
    const data = verify(q.token);
    if (!data || data.product !== 'result') {
      return { statusCode: 403, body: 'This link has expired. Request a new one from the site.' };
    }
    leadId = data.leadId;
  }

  if (!leadId) {
    return { statusCode: 400, body: 'leadId is required.' };
  }

  try {
    const entitlements = await getEntitlements(leadId);
    if (!entitlements.paid10) {
      return { statusCode: 403, body: 'The pre-screen result is not unlocked for this account yet.' };
    }

    const answers = await getLead(leadId);
    if (!answers) {
      return { statusCode: 404, body: 'No saved pre-screen answers were found for this account.' };
    }

    const pdfBytes = await buildResultPdf(answers);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="RentReady-Pre-Screen-Results.pdf"',
        'Cache-Control': 'private, no-store',
      },
      isBase64Encoded: true,
      body: Buffer.from(pdfBytes).toString('base64'),
    };
  } catch (err) {
    console.error('download-result-pdf error', err);
    return { statusCode: 500, body: 'Could not generate the PDF right now.' };
  }
};

async function buildResultPdf(answers) {
  const first = answers.first_name || 'there';
  const income = Number(answers.annual_income) || null;
  const rent = Number(answers.rent_budget) || null;
  const tier = creditTier(answers.credit_score || '');
  const creditLabel = CREDIT_LABELS[answers.credit_score] || 'Not provided';
  const timelineLabel = TIMELINE_LABELS[answers.move_timeline] || 'on a flexible timeline';
  const benchmarkMet = incomeMeetsBenchmark(income, rent);

  const incomeStatus =
    benchmarkMet === null ? 'Not Enough Info' : benchmarkMet ? 'Common Benchmark Met' : 'Review Recommended';
  const creditStatus =
    tier === 'strong' ? 'Stronger Position' : tier === 'mid' ? 'Review Recommended' : tier === 'low' ? 'Needs Attention' : 'Not Provided';
  const targetStatus = tier === 'strong' && benchmarkMet === true ? 'Stronger Position' : 'Preparation Recommended';

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.102, 0.278, 0.192);
  const muted = rgb(0.39, 0.45, 0.41);

  let y = 740;
  const left = 56;

  const draw = (text, opts = {}) => {
    const { size = 11, f = font, color = muted, dy = 18 } = opts;
    page.drawText(text, { x: left, y, size, font: f, color });
    y -= dy;
  };

  draw('RentReady Network', { size: 12, f: bold, color: green, dy: 22 });
  draw(`${first}, here is where you stand.`, { size: 20, f: bold, color: green, dy: 30 });
  draw('Your RentReady Pre-Screen Results', { size: 11, color: muted, dy: 26 });

  draw('YOUR RESULTS', { size: 12, f: bold, color: green, dy: 20 });
  draw(`Income:            ${incomeStatus}`, { dy: 18 });
  draw(`Credit (${creditLabel}):   ${creditStatus}`, { dy: 18 });
  draw(`Move Timeline:     ${timelineLabel}`, { dy: 18 });
  draw(`Lower-Upfront Readiness:  ${targetStatus}`, { dy: 26 });

  draw('WHAT THIS MEANS FOR YOU', { size: 12, f: bold, color: green, dy: 20 });
  const meaning = wrapText(
    `Based on the answers you provided, ${
      benchmarkMet === true
        ? 'your income appears to meet a common rent-to-income benchmark. '
        : benchmarkMet === false
        ? 'your income may be worth reviewing against typical rent-to-income guidelines. '
        : ''
    }Your credit range (${creditLabel}) and your move timeline (${timelineLabel}) are two more factors worth understanding before you start applying. Property requirements vary, and this pre-screen is not a guarantee of approval or deposit terms.`,
    font,
    10.5,
    500
  );
  meaning.forEach((line) => draw(line, { size: 10.5, dy: 15 }));
  y -= 8;

  draw('YOUR NEXT MOVE', { size: 12, f: bold, color: green, dy: 20 });
  const next = wrapText(
    'Review the areas above before you start paying application fees. If you want a personalized, step-by-step plan built around these exact results, the RentReady Game Plan is available from your results page.',
    font,
    10.5,
    500
  );
  next.forEach((line) => draw(line, { size: 10.5, dy: 15 }));

  y -= 20;
  draw(
    'RentReady provides rental-readiness guidance based on information you provide. This is not a rental application, landlord approval, tenant-screening decision, or guarantee of approval or deposit terms.',
    { size: 8.5, color: rgb(0.55, 0.6, 0.57), dy: 12 }
  );

  return doc.save();
}

function wrapText(text, font, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}
