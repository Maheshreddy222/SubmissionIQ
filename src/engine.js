// Deterministic validation + appetite engine. The LLM never decides; it explains these results.
const fs = require('fs');
const path = require('path');
const GUIDELINES_FILE = path.join(__dirname, '..', 'data', 'guidelines.json');
const loadGuidelines = () => JSON.parse(fs.readFileSync(GUIDELINES_FILE, 'utf8'));

const REQUIRED = [
  ['insured_name', 'Named insured', true], ['address', 'Location address', true], ['state', 'State', true],
  ['class_of_business', 'Class / occupancy', true], ['construction', 'Construction type', true],
  ['year_built', 'Year built', true], ['square_feet', 'Square footage', true], ['sprinklered', 'Sprinkler status', true],
  ['tiv_building', 'Building value', true], ['tiv_contents', 'Contents value', false], ['tiv_bi', 'Business income value', false],
  ['effective_date', 'Effective date', true], ['years_in_business', 'Years in business', false],
  ['annual_revenue', 'Annual revenue', false], ['loss_history', '5-year loss history', true],
  ['protection_class', 'Protection class', false], ['prior_carrier', 'Prior carrier', false]
];
const missingVal = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
// Never silently treat missing coverage values as $0.
// TIV is complete only when all components are known,
// unless an explicit reconciled total is supplied.
const knownMoney = (v) =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  v >= 0;

const tivOf = (ex) => {
  if (knownMoney(ex.tiv_total)) {
    return ex.tiv_total;
  }

  if (
    ![
      ex.tiv_building,
      ex.tiv_contents,
      ex.tiv_bi
    ].every(knownMoney)
  ) {
    return null;
  }

  return (
    ex.tiv_building +
    ex.tiv_contents +
    ex.tiv_bi
  );
};
function validate(ex, opts = {}) {
  const missing = [], present = [], ev = opts.evidence || {};
  for (const [key, label, critical] of REQUIRED) (missingVal(ex[key]) ? missing : present).push({ key, label, critical });
  const flags = [], now = new Date(), yr = now.getFullYear();
  if (ex.year_built && (ex.year_built < 1800 || ex.year_built > yr + 1)) flags.push({ severity: 'warn', text: `Year built ${ex.year_built} looks implausible.` });
  if (ex.effective_date && new Date(ex.effective_date) < new Date(now.toDateString())) flags.push({ severity: 'warn', text: `Effective date ${ex.effective_date} is in the past.` });
  if (ex.state && !/^[A-Z]{2}$/.test(ex.state)) flags.push({ severity: 'warn', text: `State "${ex.state}" is not a valid 2-letter code.` });
  if (ex.annual_revenue && ex.employees && ex.annual_revenue / ex.employees < 20000) flags.push({ severity: 'info', text: 'Revenue per employee is very low; confirm revenue figure.' });
  for (const l of ex.loss_history || []) if (l.year && l.year > yr) flags.push({ severity: 'warn', text: `Loss year ${l.year} is in the future.` });
  for (const c of opts.conflicts || []) {
    const lab = c.field === 'sov_total' ? 'Schedule of values total' : (REQUIRED.find((r) => r[0] === c.field) || [c.field, c.field])[1];
    flags.push({ severity: 'warn', text: c.note ? `${lab}: ${c.note} (declared ${c.others[0].value?.toLocaleString?.() ?? c.others[0].value}, rows add up to ${c.chosen.value?.toLocaleString?.() ?? c.chosen.value}).`
      : `${lab} differs between documents: using ${c.chosen.value} (${c.chosen.doc}, p.${c.chosen.page}); also found ${c.others.map((o) => `${o.value} (${o.doc}, p.${o.page})`).join('; ')}.` });
  }
  const lowConfidence = REQUIRED.filter(([k]) => ev[k] && ev[k].method !== 'user' && ev[k].confidence < 0.6 && !missingVal(ex[k])).map(([k, label]) => ({ key: k, label, confidence: ev[k].confidence }));
  for (const l of lowConfidence) flags.push({ severity: 'info', text: `Low-confidence extraction for ${l.label.toLowerCase()} (${Math.round(l.confidence * 100)}%): please verify against the source.` });
  for (const d of opts.unread || []) flags.push({ severity: 'warn', text: `${d.name} is a scanned document or image and could not be read without AI OCR (set GEMINI_API_KEY).` });
  return { completeness: Math.round((present.length / REQUIRED.length) * 100), total: REQUIRED.length, missing, criticalMissing: missing.filter((m) => m.critical), flags, lowConfidence };
}

function classify(cls, g) {
  const t = (cls || '').toLowerCase() + ' ';
  for (const tier of ['prohibited', 'referral', 'preferred']) {
    const hit = g.classes[tier].find((k) => t.includes(k));
    if (hit) return { tier, match: hit.trim() };
  }
  return { tier: 'standard', match: null };
}

function evaluateAppetite(ex, g, ctx = {}) {
  const checks = [];
  const add = (id, name, status, detail, ref) => checks.push({ id, name, status, detail, ref });
  const tiv = tivOf(ex);

  // 1. State
  if (!ex.state) add('state', 'Admitted state', 'unknown', 'State not provided.', '§1');
  else if (g.states_admitted.includes(ex.state)) add('state', 'Admitted state', 'pass', `${ex.state} is an admitted state.`, '§1');
  else add('state', 'Admitted state', 'decline', `${ex.state} is outside the carrier's admitted states.`, '§1');

  // 2. Class
  if (!ex.class_of_business) add('class', 'Class of business', 'unknown', 'Class / occupancy not provided.', '§2');
  else {
    const c = classify(ex.class_of_business, g);
    if (c.tier === 'prohibited') add('class', 'Class of business', 'decline', `"${ex.class_of_business}" matches prohibited class "${c.match}".`, '§2.3');
    else if (c.tier === 'referral') add('class', 'Class of business', 'refer', `"${ex.class_of_business}" matches referral class "${c.match}" - senior underwriter review required.`, '§2.2');
    else if (c.tier === 'preferred') add('class', 'Class of business', 'pass', `Preferred class (matches "${c.match}").`, '§2.1');
    else add('class', 'Class of business', 'pass', 'Class is not restricted (standard appetite).', '§2');
  }

  // 3. TIV
if (tiv === null) {
  add(
    'tiv',
    'Total insured value',
    'unknown',
    'One or more TIV components are missing; do not assume missing values are $0. Reconcile the complete schedule of values.',
    '§3'
  );
} else if (tiv > g.limits.max_tiv) {
  add(
    'tiv',
    'Total insured value',
    'decline',
    `TIV ${usd(tiv)} exceeds the maximum capacity of ${usd(g.limits.max_tiv)}.`,
    '§3.2'
  );
} else if (tiv > g.limits.uw_authority_tiv) {
  add(
    'tiv',
    'Total insured value',
    'refer',
    `TIV ${usd(tiv)} exceeds underwriter authority of ${usd(g.limits.uw_authority_tiv)}.`,
    '§3.1'
  );
} else {
  add(
    'tiv',
    'Total insured value',
    'pass',
    `TIV ${usd(tiv)} is within underwriter authority (${usd(g.limits.uw_authority_tiv)}).`,
    '§3.1'
  );
}

  // 4. Construction
  const c = (ex.construction || '').toLowerCase();
  const frame = /\b(frame|wood)\b/.test(c) && !/non-?combustible|masonry/.test(c);
  if (!ex.construction) add('construction', 'Construction', 'unknown', 'Construction type not provided.', '§4');
  else if (frame && ex.stories && ex.stories > g.construction.frame_max_stories) add('construction', 'Construction', 'decline', `Frame construction over ${g.construction.frame_max_stories} stories (${ex.stories}).`, '§4.1');
  else if (frame && ex.sprinklered === false) add('construction', 'Construction', 'refer', 'Frame construction without sprinklers requires referral.', '§4.2');
  else if (frame && ex.sprinklered === null) add('construction', 'Construction', 'unknown', 'Frame construction - sprinkler status needed.', '§4.2');
  else add('construction', 'Construction', 'pass', `${ex.construction} is acceptable.`, '§4');

  // 5. Sprinklers for large TIV
if (tiv === null) {
  add(
    'sprinkler',
    'Sprinkler requirement',
    'unknown',
    'TIV is incomplete, so the $5M sprinkler threshold cannot be determined. Verify TIV and sprinkler evidence.',
    '§4.3'
  );
} else if (tiv > g.limits.sprinkler_required_above_tiv) {
  if (ex.sprinklered === true) {
    add(
      'sprinkler',
      'Sprinkler requirement',
      'pass',
      `Sprinklered, as required above ${usd(g.limits.sprinkler_required_above_tiv)} TIV.`,
      '§4.3'
    );
  } else if (ex.sprinklered === false) {
    add(
      'sprinkler',
      'Sprinkler requirement',
      'refer',
      `Unsprinklered with TIV above ${usd(g.limits.sprinkler_required_above_tiv)}.`,
      '§4.3'
    );
  } else {
    add(
      'sprinkler',
      'Sprinkler requirement',
      'unknown',
      'Sprinkler status needed for this TIV.',
      '§4.3'
    );
  }
} else {
  add(
    'sprinkler',
    'Sprinkler requirement',
    'pass',
    `Not required below ${usd(g.limits.sprinkler_required_above_tiv)} TIV.`,
    '§4.3'
  );
}

  // 6. Building age
  if (!ex.year_built) add('age', 'Building age', 'unknown', 'Year built not provided.', '§5');
  else if (ex.year_built < g.building_age.refer_before_year) add('age', 'Building age', 'refer', `Built ${ex.year_built}, before ${g.building_age.refer_before_year}: request roof, electrical, plumbing and HVAC update years.`, '§5');
  else add('age', 'Building age', 'pass', `Built ${ex.year_built}.`, '§5');

  // 7. Losses
  const L = g.losses;
  if (ex.loss_history === null) add('losses', 'Loss history', 'unknown', 'No loss history provided.', '§6');
  else {
    const n = ex.loss_history.length, total = ex.loss_history.reduce((s, l) => s + (l.paid || 0), 0);
    const big = ex.loss_history.filter((l) => l.paid >= L.refer_single_loss);
    const open = ex.loss_history.filter((l) => /open/i.test(l.status || ''));
    const bits = `${n} loss${n === 1 ? '' : 'es'}, ${usd(total)} total paid${open.length ? `, ${open.length} still open` : ''}`;
    if (total >= L.decline_total_paid) add('losses', 'Loss history', 'decline', `${bits} - exceeds ${usd(L.decline_total_paid)} ${L.years}-year threshold.`, '§6.3');
    else if (n >= L.refer_count || big.length) {
      const why = [n >= L.refer_count && `${n} losses (limit ${L.refer_count - 1})`, big.length && `single loss of ${usd(big[0].paid)} (limit ${usd(L.refer_single_loss)})`].filter(Boolean).join(' and ');
      add('losses', 'Loss history', 'refer', `${bits}: ${why}.`, '§6.1-6.2');
    } else add('losses', 'Loss history', 'pass', n ? `${bits}.` : 'No losses reported.', '§6');
  }

  // 8. Experience
  if (ex.years_in_business === null || ex.years_in_business === undefined) add('experience', 'Operating experience', 'unknown', 'Years in business not provided.', '§7');
  else if (ex.years_in_business < g.experience.min_years_in_business) add('experience', 'Operating experience', 'refer', `Only ${ex.years_in_business} year(s) in business.`, '§7');
  else add('experience', 'Operating experience', 'pass', `${ex.years_in_business} years in business.`, '§7');

  // 9. Protection class
  if (ex.protection_class === null || ex.protection_class === undefined) add('ppc', 'Fire protection class', 'unknown', 'Protection class not provided.', '§8');
  else if (ex.protection_class >= g.protection_class.refer_at_or_above) add('ppc', 'Fire protection class', 'refer', `Protection class ${ex.protection_class} is ${g.protection_class.refer_at_or_above} or worse.`, '§8');
  else add('ppc', 'Fire protection class', 'pass', `Protection class ${ex.protection_class}.`, '§8');

  // 10. Insured value adequacy (screening estimate)
  const val = ctx.valuation;
  if (!val || val.status === 'not_assessed') add('valuation', 'Insured value adequacy', 'unknown', 'Building value or area missing, so adequacy cannot be screened.', '§9');
  else if (val.status === 'undervalued' && g.valuation?.refer_if_undervalued) add('valuation', 'Insured value adequacy', 'refer', val.summary + ' Request a current valuation.', '§9.1');
  else if (val.status === 'unusually_high' && g.valuation?.refer_if_unusually_high) add('valuation', 'Insured value adequacy', 'refer', val.summary, '§9.2');
  else add('valuation', 'Insured value adequacy', 'pass', val.summary, '§9');

  // 11. Flood hazard (FEMA NFHL, when the lookup succeeded)
  const fl = ctx.hazard?.flood;
  if (!fl || !fl.level) add('flood', 'Flood hazard', 'unknown', ctx.hazard?.status === 'disabled' ? 'Location lookup is switched off.' : (ctx.hazard?.error || 'Flood zone not available for this address.'), '§10');
  else if (fl.level === 'high' && g.flood?.refer_in_special_flood_hazard_area) add('flood', 'Flood hazard', 'refer', `FEMA zone ${fl.zone}: ${fl.description}. Flood terms and limits need review.`, '§10.1');
  else add('flood', 'Flood hazard', 'pass', `FEMA zone ${fl.zone}: ${fl.description}.`, '§10');
  return decorate(checks, g);
}

const CHECK_META = {
  state: { rule: (g) => `Property must be in an admitted state (${g.states_admitted.join(', ')}).`, inputs: ['state'] },
  class: { rule: () => 'Class of business must not be prohibited; referral classes go to a senior underwriter.', inputs: ['class_of_business'] },
  tiv: { rule: (g) => `Total insured value within underwriter authority (${usd(g.limits.uw_authority_tiv)}); above ${usd(g.limits.max_tiv)} is declined.`, inputs: ['tiv_building', 'tiv_contents', 'tiv_bi'] },
  construction: { rule: (g) => `Frame construction needs sprinklers (else referral) and is limited to ${g.construction.frame_max_stories} stories.`, inputs: ['construction', 'stories', 'sprinklered'] },
  sprinkler: { rule: (g) => `Sprinklers required when TIV exceeds ${usd(g.limits.sprinkler_required_above_tiv)}.`, inputs: ['sprinklered', 'tiv_building'] },
  age: { rule: (g) => `Buildings built before ${g.building_age.refer_before_year} are referred for update information.`, inputs: ['year_built'] },
  losses: { rule: (g) => `Refer at ${g.losses.refer_count}+ losses or a single loss of ${usd(g.losses.refer_single_loss)}+; decline at ${usd(g.losses.decline_total_paid)}+ total paid (${g.losses.years} years).`, inputs: ['loss_history'] },
  experience: { rule: (g) => `At least ${g.experience.min_years_in_business} years in business.`, inputs: ['years_in_business'] },
  ppc: { rule: (g) => `Protection class ${g.protection_class.refer_at_or_above} or worse is referred.`, inputs: ['protection_class'] },
  valuation: { rule: () => 'Declared building value is screened against an estimated replacement-cost range; large gaps are referred.', inputs: ['tiv_building', 'square_feet', 'construction', 'class_of_business'] },
  flood: { rule: () => 'Properties in a FEMA Special Flood Hazard Area are referred.', inputs: ['address'] }
};
function decorate(checks, g) {
  return checks.map((c) => ({ ...c, rule: CHECK_META[c.id] ? CHECK_META[c.id].rule(g) : '', inputs: CHECK_META[c.id]?.inputs || [], guidelineVersion: g.version }));
}

function decide(validation, checks, ex) {
  const declines = checks.filter((c) => c.status === 'decline');
  const refers = checks.filter((c) => c.status === 'refer');
  let recommendation = 'Quote';
  if (declines.length) recommendation = 'Decline';
  else if (validation.criticalMissing.length) recommendation = 'Need Info';
  else if (refers.length) recommendation = 'Refer';
  const nLoss = (ex.loss_history || []).length;
  let score = 100 - declines.length * 35 - refers.length * 12 - validation.criticalMissing.length * 6 - nLoss * 3;
  score = Math.max(5, Math.min(99, score));
  return { recommendation, score };
}

module.exports = { loadGuidelines, validate, evaluateAppetite, decide, tivOf, usd, GUIDELINES_FILE };
