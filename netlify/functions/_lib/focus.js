// Mirrors the branching logic in the result page / game-plan.html.
// Kept in one small server-side place so the $97 Credit Action Kit can be
// gated server-side, not just hidden by frontend JS — a user editing the
// page's JavaScript should not be able to unlock an offer that isn't
// actually relevant to them.
function creditTier(code) {
  if (['below_580', '580_619', '620_659'].includes(code)) return 'low';
  if (['660_699', '700_739'].includes(code)) return 'mid';
  if (['740_799', '800_plus'].includes(code)) return 'strong';
  return 'unknown';
}

function incomeMeetsBenchmark(income, rent) {
  if (!income || !rent) return null;
  return income / 12 >= rent * 3;
}

function determineFocus(answers) {
  const income = Number(answers && answers.annual_income) || null;
  const rent = Number(answers && answers.rent_budget) || null;
  const tier = creditTier((answers && answers.credit_score) || '');
  const benchmarkMet = incomeMeetsBenchmark(income, rent);
  if (tier === 'low' || tier === 'mid') return 'credit';
  if (tier === 'strong' && benchmarkMet === false) return 'income';
  return 'general';
}

module.exports = { creditTier, incomeMeetsBenchmark, determineFocus };
