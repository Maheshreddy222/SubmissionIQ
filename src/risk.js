// Property risk score (0-100, higher = riskier). Fully configurable via data/risk_model.json. Deterministic and explainable.
const fs = require('fs'), path = require('path');
const MODEL_FILE = path.join(__dirname, '..', 'data', 'risk_model.json');
const loadModel = () => JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const has = (text, list) => list.some((m) => (String(text || '').toLowerCase() + ' ').includes(m));
const level = (p, max) => (max ? (p / max < 0.34 ? 'low' : p / max < 0.67 ? 'medium' : 'high') : 'low');

function scoreRisk(ex, ctx = {}, model = loadModel()) {
  const F = model.factors, factors = [], ev = (...fs) => fs.map((f) => ({ field: f, value: ex[f] ?? null, source: ctx.evidence?.[f] ? { doc: ctx.evidence[f].doc, docId: ctx.evidence[f].docId, page: ctx.evidence[f].page } : null }));
  const tiv = (ex.tiv_building || 0) + (ex.tiv_contents || 0) + (ex.tiv_bi || 0);
  const add = (id, label, points, max, reason, evidence, extra = {}) => factors.push({ id, label, points: Math.round(points * 10) / 10, max, level: extra.unassessed ? 'unknown' : level(points, max), reason, evidence, assumed: !!extra.assumed, unassessed: !!extra.unassessed });

  // Construction
  { const f = F.construction; const t = (ex.construction || '').toLowerCase();
    const rule = ex.construction ? f.rules.filter((r) => has(t, r.match)).sort((a, b) => a.points - b.points)[0] : null;
    // "masonry non-combustible" must not be read as frame
    const frame = /\b(frame|wood)\b/.test(t) && !/non-?combustible|masonry/.test(t);
    const pts = !ex.construction ? f.unknown : frame ? f.rules.find((r) => r.match.includes('frame')).points : (rule ? rule.points : f.unknown);
    add('construction', 'Construction', pts, f.max, !ex.construction ? 'Construction type not provided (assumed mid-risk).' : frame ? `${ex.construction}: combustible frame construction.` : `${ex.construction}.`, ev('construction'), { assumed: !ex.construction }); }
  // Age
  { const f = F.age; const y = ex.year_built; const r = y ? f.rules.find((x) => y < x.before) : null;
    add('age', 'Building age', y ? r.points : f.unknown, f.max, y ? `Built ${y} (${new Date().getFullYear() - y} years old).` : 'Year built not provided (assumed mid-risk).', ev('year_built'), { assumed: !y }); }
  // Fire protection
  { const f = F.protection; let p, why = [];
    if (ex.sprinklered === true) { p = f.sprinklered; why.push('Sprinklered'); }
    else if (ex.sprinklered === false) { p = tiv > f.large_tiv ? f.unsprinklered_large_tiv : f.unsprinklered; why.push(`No sprinklers${tiv > f.large_tiv ? ` with TIV ${usd(tiv)}` : ''}`); }
    else { p = f.sprinkler_unknown; why.push('Sprinkler status unknown (assumed)'); }
    const ppc = ex.protection_class; const pr = ppc ? f.ppc.find((x) => ppc >= x.min) : null;
    p += ppc ? pr.points : f.ppc_unknown; why.push(ppc ? `protection class ${ppc}` : 'protection class not provided');
    add('protection', 'Fire protection', Math.min(f.max, p), f.max, why.join(', ') + '.', ev('sprinklered', 'protection_class'), { assumed: ex.sprinklered === null || !ppc }); }
  // Occupancy
  { const f = F.occupancy; const m = ex.class_of_business ? f.rules.filter((r) => has(ex.class_of_business, r.match)).sort((a, b) => b.points - a.points)[0] : null;
    add('occupancy', 'Occupancy hazard', m ? m.points : f.default, f.max, ex.class_of_business ? `${ex.class_of_business}${m ? '' : ' (not specifically rated, default)'}.` : 'Occupancy not provided (default).', ev('class_of_business'), { assumed: !ex.class_of_business }); }
  // Losses
  { const f = F.losses, L = ex.loss_history;
    if (L === null || L === undefined) add('losses', 'Loss history', f.unknown, f.max, 'No loss history provided (assumed mid-risk).', ev('loss_history'), { assumed: true });
    else {
      const n = L.length, freq = Math.min(f.frequency_cap, n * f.per_loss), top = Math.max(0, ...L.map((l) => l.paid || 0));
      const sev = (f.severity.find((s) => top >= s.min) || { points: 0 }).points;
      const hz = L.filter((l) => f.hazard_causes.some((c) => String(l.cause || '').toLowerCase().includes(c)));
      const open = L.filter((l) => /open/i.test(l.status || ''));
      const pts = Math.min(f.max, freq + sev + (hz.length ? f.hazard_cause_points : 0) + (open.length ? f.open_claim_points : 0));
      const bits = [`${n} loss${n === 1 ? '' : 'es'}`]; if (top) bits.push(`largest ${usd(top)}`); if (hz.length) bits.push(`${hz.length} fire/explosion/electrical`); if (open.length) bits.push(`${open.length} open`);
      add('losses', 'Loss history', pts, f.max, n ? bits.join(', ') + '.' : 'No losses reported.', ev('loss_history'));
    } }
  // Exposure
  { const f = F.exposure; const r = tiv ? f.rules.find((x) => tiv >= x.min) : null;
    add('exposure', 'Exposure size', r ? r.points : 0, f.max, tiv ? `Total insured value ${usd(tiv)}.` : 'TIV not available.', ev('tiv_building', 'tiv_contents', 'tiv_bi'), { unassessed: !tiv }); }
  // Location (flood hazard from the configured source)
  { const f = F.location, fl = ctx.hazard?.flood;
    if (fl && fl.level && f.flood[fl.level] !== undefined) add('location', 'Location hazard (flood)', f.flood[fl.level], f.max, `FEMA flood zone ${fl.zone}: ${fl.description}.`, [{ field: 'address', value: ex.address, source: { doc: fl.source, page: null } }]);
    else add('location', 'Location hazard (flood)', 0, f.max, ctx.hazard?.status === 'disabled' ? 'Location lookup is switched off.' : 'Not assessed: hazard data unavailable for this address.', ev('address'), { unassessed: true }); }
  // Valuation
  { const f = F.valuation, v = ctx.valuation;
    if (v && v.status && v.status !== 'not_assessed') {
      const map = { undervalued: f.undervalued, below_range: f.below_range, unusually_high: f.unusually_high, within_range: 0 };
      add('valuation', 'Insured value adequacy', map[v.status] ?? 0, f.max, v.summary, ev('tiv_building', 'square_feet'));
    } else add('valuation', 'Insured value adequacy', 0, f.max, 'Not assessed: building value or area missing.', ev('tiv_building', 'square_feet'), { unassessed: true }); }

  const scored = factors.filter((x) => !x.unassessed);
  const total = scored.reduce((s, x) => s + x.points, 0), max = scored.reduce((s, x) => s + x.max, 0);
  const score = max ? Math.round((total / max) * 100) : null;
  const band = score === null ? 'Unknown' : model.bands.find((b) => score <= b.max).name;
  const drivers = [...scored].sort((a, b) => b.points / b.max - a.points / a.max || b.points - a.points).filter((x) => x.points / x.max >= 0.5).slice(0, 3).map((x) => ({ id: x.id, label: x.label, reason: x.reason }));
  return { score, band, factors, drivers, assessed: scored.length, total: factors.length, assumed: factors.filter((x) => x.assumed).map((x) => x.id), notAssessed: factors.filter((x) => x.unassessed).map((x) => x.id), modelVersion: model.version };
}

// Account-level score for multi-location schedules: TIV-weighted average of location scores; worst location reported.
function scoreAccount(ex, ctx, locations, model) {
  if (!locations || locations.length < 2) return { ...scoreRisk(ex, ctx, model), locations: null };
  const per = locations.map((l) => {
    const lex = { ...ex, ...Object.fromEntries(['address', 'class_of_business', 'construction', 'year_built', 'stories', 'square_feet', 'sprinklered', 'protection_class', 'tiv_building', 'tiv_contents', 'tiv_bi'].map((k) => [k, l[k] ?? null])) };
    const vlocal = ctx.valuationByLoc?.[l.loc_no]; const hz = ctx.hazardByLoc?.[l.loc_no];
    return { loc_no: l.loc_no, name: l.name, address: l.address, tiv: l.tiv, ...scoreRisk(lex, { evidence: null, valuation: vlocal, hazard: hz }, model) };
  });
  const totalTiv = per.reduce((s, p) => s + (p.tiv || 0), 0) || 1;
  const wavg = Math.round(per.reduce((s, p) => s + (p.score ?? 0) * ((p.tiv || 0) / totalTiv), 0));
  const worst = [...per].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const acct = scoreRisk(ex, ctx, model);
  const score = Math.max(wavg, Math.round(0.5 * wavg + 0.5 * (worst.score ?? 0)));
  return { ...acct, score, band: model.bands.find((b) => score <= b.max).name, locations: per, worst: { loc_no: worst.loc_no, name: worst.name, score: worst.score }, method: 'TIV-weighted average blended with the worst location' };
}

module.exports = { scoreRisk, scoreAccount, loadModel, MODEL_FILE };
