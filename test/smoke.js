// Offline end-to-end checks: ingestion -> evidence-aware extraction -> valuation -> risk score -> appetite -> priority.
const assert = require('assert');
const Samples = require('../src/samples');
const { ingest } = require('../src/docs');
const { runOffline } = require('../src/intake');
const { assess } = require('../src/analysis');
const { scoreRisk } = require('../src/risk');
const { priority } = require('../src/priority');
const E = require('../src/engine');

const EXPECTED = { '01': 'Quote', '02': 'Need Info', '03': 'Refer', '04': 'Decline', '05': 'Refer', '06': 'Decline', '07': 'Refer', '08': 'Decline', '09': 'Refer',
  '10': 'Refer', '11': 'Refer', '12': 'Decline', '13': 'Refer', '14': 'Need Info', '15': 'Refer' };

async function run(id) {
  const docs = [];
  for (const [i, f] of Samples.files(id).entries()) docs.push({ id: i + 1, ...(await ingest(f)) });
  const r = runOffline(docs);
  const a = assess(r.extracted, { evidence: r.evidence, conflicts: r.conflicts, locations: r.locations, declaredTotal: r.declaredTotal, unread: r.unread });
  return { docs, ...r, ...a };
}

(async () => {
  const results = {};
  for (const s of Samples.index()) {
    const r = await run(s.id); results[s.id.slice(0, 2)] = r;
    console.log(`${s.id.slice(0, 2)} ${s.title.padEnd(30)} ${r.recommendation.padEnd(10)} risk ${String(r.risk.score).padStart(3)} ${r.risk.band.padEnd(8)} docs ${r.docs.length}  fields ${Object.keys(r.evidence).length}`);
    assert.strictEqual(r.recommendation, EXPECTED[s.id.slice(0, 2)], `${s.id}: expected ${EXPECTED[s.id.slice(0, 2)]} got ${r.recommendation}`);
  }
  // 1. Risk score: combustible, unsprinklered warehouse with fire claims is far riskier than a sprinklered office
  const risky = scoreRisk({ class_of_business: 'Warehouse', construction: 'Wood frame', year_built: 1968, sprinklered: false, protection_class: 6, tiv_building: 3e6, tiv_contents: 2e6, tiv_bi: 5e5,
    loss_history: [{ year: 2023, cause: 'Fire - storage area', paid: 220000, status: 'Closed' }, { year: 2024, cause: 'Electrical fire', paid: 95000, status: 'Closed' }, { year: 2025, cause: 'Fire - loading dock', paid: 60000, status: 'Open' }] });
  const safe = scoreRisk({ class_of_business: 'Office building', construction: 'Fire resistive', year_built: 2015, sprinklered: true, protection_class: 2, tiv_building: 6e6, tiv_contents: 3e5, tiv_bi: 4e5, loss_history: [] });
  console.log(`risk: warehouse ${risky.score} (${risky.band}) vs office ${safe.score} (${safe.band})`);
  assert(risky.score >= 65 && risky.band === 'High'); assert(safe.score <= 24 && safe.band === 'Low'); assert(risky.drivers.length >= 2);
  // 2. Multi-document submission: locations from SOV, losses from loss run, insured from email, reconciliation conflict
  const m = results['13'];
  assert.strictEqual(m.locations.length, 5); assert.strictEqual(m.extracted.loss_history.length, 5);
  assert.strictEqual(m.extracted.insured_name, 'Carolina Retail Group Inc'); assert.strictEqual(m.extracted.tiv_building, 16950000);
  assert(m.conflicts.some((c) => c.field === 'sov_total'), 'SOV total mismatch should be flagged');
  assert(m.valuation.flagged.some((f) => f.name === 'Pad B Restaurant' && f.status === 'undervalued'));
  assert(m.evidence.loss_history.doc.includes('loss-runs') && m.evidence.insured_name.doc.includes('email'));
  assert(m.risk.locations && m.risk.locations.length === 5 && m.risk.worst);
  // 3. Page-level evidence from a multi-page PDF
  const p = results['15'];
  assert.strictEqual(p.evidence.insured_name.page, 1); assert.strictEqual(p.evidence.year_built.page, 2); assert.strictEqual(p.evidence.prior_carrier.page, 2);
  assert(/Copper Canyon/.test(p.evidence.insured_name.quote)); assert.strictEqual(p.extracted.loss_history.length, 2);
  // 4. Scanned image cannot be read offline: flagged instead of guessed
  assert.strictEqual(results['14'].unread.length, 1); assert(results['14'].validation.flags.some((f) => /scanned/i.test(f.text)));
  // 5. Valuation screening flags underinsurance and explains the basis
  const v = results['10'].valuation; assert.strictEqual(v.status, 'undervalued'); assert(v.low > 1e6 && v.basis.benchmark_version);
  // 6. Appetite checks carry rule text, inputs and guideline version for explainability
  assert(results['04'].checks.every((c) => c.rule && c.inputs.length && c.guidelineVersion));
  // 7. Priority: urgent, high-risk, incomplete submissions outrank clean ones
  const row = (k, extra = {}) => ({ status: 'Pending review', recommendation: results[k].recommendation, created_at: new Date().toISOString(), extracted: results[k].extracted, validation: results[k].validation, risk: results[k].risk, ...extra });
  const pr = { urgent: priority(row('08')), calm: priority(row('01')) };
  console.log(`priority: vacant building ${pr.urgent.score} ${pr.urgent.level} (${pr.urgent.reasons.join('; ')}) vs clean office ${pr.calm.score} ${pr.calm.level}`);
  assert(pr.urgent.score > pr.calm.score);
  assert.strictEqual(priority(row('01', { decision: { outcome: 'Quote' } })).level, 'Done');
  console.log('All smoke tests passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
