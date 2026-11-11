// Replacement-cost SCREENING estimate. Illustrative benchmarks; not a certified valuation.
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'valuation.json');
const loadValuation = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const hit = (text, list) => list.some((m) => (String(text || '').toLowerCase() + ' ').includes(m));

function screen(loc, cfg = loadValuation()) {
  const declared = loc.tiv_building, sqft = loc.square_feet;
  if (!declared || !sqft) return { status: 'not_assessed', summary: 'Not assessed: building value or square footage missing.' };
  const occ = cfg.occupancy_ranges.find((r) => hit(loc.class_of_business, r.match)) || cfg.default;
  const cf = (cfg.construction_factors.find((r) => hit(loc.construction, r.match)) || { factor: 1 }).factor;
  const rf = cfg.region_factors[loc.state] ?? cfg.default_region;
  const low = sqft * occ.low * cf * rf, high = sqft * occ.high * cf * rf, mid = (low + high) / 2;
  const psf = declared / sqft, t = cfg.thresholds;
  let status = 'within_range';
  if (declared < low * t.undervalued_ratio_to_low) status = 'undervalued';
  else if (declared < low) status = 'below_range';
  else if (declared > high * t.unusually_high_ratio_to_high) status = 'unusually_high';
  const pct = Math.round((declared / mid) * 100);
  const text = { undervalued: `Declared ${usd(declared)} (${usd(psf)}/sq ft) is far below the screening range ${usd(low)} to ${usd(high)}: possible underinsurance.`,
    below_range: `Declared ${usd(declared)} (${usd(psf)}/sq ft) is slightly below the screening range ${usd(low)} to ${usd(high)}.`,
    unusually_high: `Declared ${usd(declared)} (${usd(psf)}/sq ft) is well above the screening range ${usd(low)} to ${usd(high)}: verify the figure.`,
    within_range: `Declared ${usd(declared)} (${usd(psf)}/sq ft) is within the screening range ${usd(low)} to ${usd(high)}.` }[status];
  return { status, declared, sqft, psf: Math.round(psf), low: Math.round(low), high: Math.round(high), mid: Math.round(mid), itv_pct: pct, summary: text,
    basis: { occupancy_psf: [occ.low, occ.high], construction_factor: cf, region_factor: rf, state: loc.state || null, benchmark_version: cfg.version, as_of: cfg.as_of },
    disclaimer: 'Screening estimate from illustrative benchmarks, not a certified valuation.' };
}

function screenAll(ex, locations, cfg) {
  const main = screen(ex, cfg);
  if (!locations || locations.length < 2) return { ...main, byLocation: null };
  const by = {};
  for (const l of locations) by[l.loc_no] = { name: l.name, address: l.address, ...screen({ ...l, state: l.state || ex.state }, cfg) };
  const flagged = Object.entries(by).filter(([, v]) => ['undervalued', 'unusually_high'].includes(v.status));
  const worst = flagged[0];
  const status = flagged.some(([, v]) => v.status === 'undervalued') ? 'undervalued' : flagged.length ? 'unusually_high' : Object.values(by).some((v) => v.status === 'below_range') ? 'below_range' : 'within_range';
  const sumDecl = Object.values(by).reduce((s, v) => s + (v.declared || 0), 0), sumMid = Object.values(by).reduce((s, v) => s + (v.mid || 0), 0);
  return { status, byLocation: by, flagged: flagged.map(([k, v]) => ({ loc_no: k, name: v.name, status: v.status })), declared: sumDecl, mid: sumMid, itv_pct: sumMid ? Math.round((sumDecl / sumMid) * 100) : null,
    summary: flagged.length ? `${flagged.length} of ${Object.keys(by).length} locations look ${status === 'undervalued' ? 'undervalued' : 'unusually valued'} against screening ranges (first: ${worst[1].name || 'Loc ' + worst[0]}).` : `All ${Object.keys(by).length} locations are broadly within screening ranges.`,
    disclaimer: 'Screening estimate from illustrative benchmarks, not a certified valuation.' };
}

module.exports = { screen, screenAll, loadValuation, FILE };
