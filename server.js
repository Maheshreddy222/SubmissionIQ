require('dotenv').config({ quiet: true });
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./src/db');
const llm = require('./src/llm');
const E = require('./src/engine');
const Samples = require('./src/samples');
const { ingest } = require('./src/docs');
const { one } = require('./src/intake');
const { runPipeline } = require('./src/pipeline');
const { priority } = require('./src/priority');
const { loadModel } = require('./src/risk');
const { loadValuation } = require('./src/valuation');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 12 } });
const MANUAL_MINUTES = +process.env.MANUAL_MINUTES || 45;
const UPLOADS = path.join(__dirname, 'data', 'uploads');
const J = (s) => (s ? JSON.parse(s) : null);
const EDITABLE = ['insured_name', 'address', 'class_of_business', 'construction', 'year_built', 'stories', 'square_feet', 'sprinklered', 'protection_class', 'years_in_business', 'annual_revenue', 'tiv_building', 'tiv_contents', 'tiv_bi', 'effective_date', 'prior_carrier'];

app.use(express.json({ limit: '2mb' }));
app.get('/app', (_q, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.use(express.static(path.join(__dirname, 'public')));

const hydrate = (r) => r && { ...r, extracted: J(r.extracted), evidence: J(r.evidence) || {}, locations: J(r.locations) || [], validation: J(r.validation), appetite: J(r.appetite), summary: J(r.summary), decision: J(r.decision),
  risk: J(r.risk), valuation: J(r.valuation), hazards: J(r.hazards), meta: J(r.conflicts) || {} };

async function addDocument(subId, { name, buffer, mime }) {
  const d = await ingest({ buffer, name, mime });
  const dir = path.join(UPLOADS, String(subId)); fs.mkdirSync(dir, { recursive: true });
  const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${name.replace(/[^\w.-]+/g, '_')}`;
  const p = path.join(dir, safe); fs.writeFileSync(p, buffer);
  db.prepare('INSERT INTO documents (submission_id, name, mime, kind, pages, scanned, content, path, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(subId, name, d.mime, d.kind, d.pages.length, d.scanned ? 1 : 0, JSON.stringify({ pages: d.pages, tables: d.tables }), p, new Date().toISOString());
  return d;
}

// ---------- System ----------
app.get('/api/health', (_q, res) => res.json({ ok: true, provider: llm.provider(), model: llm.modelName() }));
app.get('/api/guidelines', (_q, res) => res.json(E.loadGuidelines()));
app.get('/api/config', (_q, res) => res.json({ guidelines: E.loadGuidelines(), risk_model: loadModel(), valuation: { version: loadValuation().version, note: loadValuation().note, as_of: loadValuation().as_of } }));
app.get('/api/llm/status', (_q, res) => res.json({ provider: llm.provider(), model: llm.modelName(), configured: llm.provider() !== 'offline', ocr: llm.provider() === 'gemini',
  fallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-2.5-flash-lite').split(',').map((s) => s.trim()).filter(Boolean), hazardLookup: process.env.HAZARD_LOOKUP !== 'off' }));
app.post('/api/llm/test', async (_q, res) => res.json(await llm.testConnection()));

// ---------- Samples ----------
app.get('/api/samples', (_q, res) => res.json(Samples.index()));
app.get('/api/samples/:id', (req, res) => {
  const fs_ = Samples.files(req.params.id);
  if (!fs_) return res.status(404).json({ error: 'Sample not found' });
  const text = fs_.length === 1 && /^text\//.test(fs_[0].mime) ? fs_[0].buffer.toString('utf8') : null;
  res.json({ id: req.params.id, text, files: fs_.map((f) => f.name) });
});

// ---------- Submissions ----------
app.post('/api/submissions', upload.array('files', 12), async (req, res) => {
  try {
    const inputs = [];
    let name = req.body.name || '';
    if (req.body.sample) { const f = Samples.files(req.body.sample); if (!f) return res.status(404).json({ error: 'Sample not found' }); inputs.push(...f); name = name || Samples.index().find((s) => s.id === req.body.sample)?.title; }
    for (const f of req.files || []) inputs.push({ name: f.originalname, buffer: f.buffer, mime: f.mimetype });
    const text = (req.body.text || '').trim();
    if (text.length >= 40) inputs.push({ name: 'pasted-submission.txt', buffer: Buffer.from(text), mime: 'text/plain' });
    if (!inputs.length) return res.status(400).json({ error: 'Add some submission text or upload at least one file (.pdf, .png, .jpg, .csv, .xlsx, .txt).' });
    if (text && text.length < 40 && inputs.length === 0) return res.status(400).json({ error: 'Submission text is too short.' });
    const label = name || (inputs.length === 1 ? inputs[0].name : `${inputs.length} documents: ${inputs[0].name}`);
    const id = db.prepare('INSERT INTO submissions (created_at, source_name, raw_text) VALUES (?,?,?)').run(new Date().toISOString(), label, '').lastInsertRowid;
    const texts = [];
    try { for (const f of inputs) { const d = await addDocument(id, f); texts.push(...d.pages.map((p) => p.text)); } }
    catch (e) { db.prepare('DELETE FROM submissions WHERE id=?').run(id); db.prepare('DELETE FROM documents WHERE submission_id=?').run(id); return res.status(400).json({ error: `Could not read "${e.fileName || 'a file'}": ${e.message}` }); }
    db.prepare('UPDATE submissions SET raw_text=? WHERE id=?').run(texts.join('\n\n').slice(0, 200000) || '(no readable text: scanned or image documents)', id);
    setImmediate(() => runPipeline(id));
    res.status(202).json({ id });
  } catch (e) { res.status(500).json({ error: 'Could not process the submission: ' + e.message }); }
});

function listRow(r) {
  const x = { ...r, extracted: J(r.extracted), validation: J(r.validation), risk: J(r.risk), decision: J(r.decision) };
  const p = priority(x), tiv = x.extracted ? (x.extracted.tiv_building || 0) + (x.extracted.tiv_contents || 0) + (x.extracted.tiv_bi || 0) : null;
  return { id: r.id, created_at: r.created_at, source_name: r.source_name, status: r.status, recommendation: r.recommendation, quality: r.score, insured: r.insured, processing_ms: r.processing_ms, docs: r.docs,
    decision: x.decision && { outcome: x.decision.outcome, underwriter: x.decision.underwriter, agreed: x.decision.agreed, ts: x.decision.ts }, risk: x.risk && { score: x.risk.score, band: x.risk.band, drivers: x.risk.drivers },
    priority: p, effective_date: x.extracted?.effective_date || null, tiv, completeness: x.validation?.completeness ?? null, missing: x.validation?.criticalMissing?.length ?? null,
    lowConfidence: x.validation?.lowConfidence?.length ?? 0 };
}
app.get('/api/submissions', (_q, res) => {
  const rows = db.prepare('SELECT id, created_at, source_name, status, recommendation, score, insured, processing_ms, extracted, validation, risk, decision, (SELECT COUNT(*) FROM documents d WHERE d.submission_id=submissions.id) AS docs FROM submissions').all().map(listRow);
  rows.sort((a, b) => (b.priority.score - a.priority.score) || (b.id - a.id));
  res.json(rows);
});

function trace(ex, evidence, checks) {
  return (checks || []).map((c) => ({ ...c, inputValues: (c.inputs || []).map((f) => ({ field: f, value: ex?.[f] ?? null, evidence: evidence?.[f] || null })) }));
}
app.get('/api/submissions/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const h = hydrate(r);
  const docs = db.prepare('SELECT id, name, mime, kind, pages, scanned FROM documents WHERE submission_id=? ORDER BY id').all(r.id);
  const x = { ...h }; const p = priority(x);
  res.json({ ...h, raw_text: undefined, documents: docs, priority: p, trace: h.appetite ? trace(h.extracted, h.evidence, h.appetite.checks) : [], audit: db.prepare('SELECT * FROM audit WHERE submission_id=? ORDER BY id').all(r.id) });
});

app.post('/api/submissions/:id/fields', (req, res) => {
  const r = db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status === 'Processing') return res.status(409).json({ error: 'Still processing. Try again in a moment.' });
  if (r.decision) return res.status(409).json({ error: 'A decision is already recorded. Corrections are locked to protect the audit trail.' });
  const { field, value, reviewer = 'Underwriter', reason = '' } = req.body || {};
  if (!EDITABLE.includes(field)) return res.status(400).json({ error: 'That field cannot be edited.' });
  const ex = J(r.extracted), ev = J(r.evidence) || {}, old = ex[field];
  const cleared = value === null || value === undefined || String(value).trim() === '';
  const nv = cleared ? null : one(field, value);
  if (!cleared && (nv === null || nv === undefined || Number.isNaN(nv))) return res.status(400).json({ error: 'That value could not be read for this field. Check the format (for example 1998, $2,500,000 or 2027-03-01).' });
  ex[field] = nv;
  if (field === 'address' && nv) { const n = one('address', nv); /* keep city/state in sync */ const m = String(nv).match(/,\s*([^,]+),\s*([A-Za-z]{2})\.?\s+\d{5}/); if (m) { ex.city = m[1].trim(); ex.state = m[2].toUpperCase(); } }
  ev[field] = { value: nv, docId: null, doc: 'Reviewer correction', page: null, quote: reason || '', method: 'user', confidence: 1, verified: true, by: reviewer, ts: new Date().toISOString(), original: { value: old, evidence: ev[field] || null } };
  db.prepare('UPDATE submissions SET extracted=?, evidence=?, insured=? WHERE id=?').run(JSON.stringify(ex), JSON.stringify(ev), ex.insured_name, r.id);
  db.prepare('INSERT INTO audit (submission_id, ts, agent, status, detail) VALUES (?,?,?,?,?)').run(r.id, new Date().toISOString(), reviewer, 'done', `Corrected ${field}: ${old ?? 'missing'} -> ${nv ?? 'cleared'}${reason ? ` (${reason})` : ''}. Downstream checks re-run.`);
  db.prepare("UPDATE submissions SET status='Processing' WHERE id=?").run(r.id);
  setImmediate(() => runPipeline(r.id, { reuse: true }));
  res.json({ ok: true });
});

app.post('/api/submissions/:id/rerun', (req, res) => {
  const r = db.prepare('SELECT status, decision FROM submissions WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status === 'Processing') return res.status(409).json({ error: 'Already processing' });
  if (r.decision) return res.status(409).json({ error: 'A decision is already recorded.' });
  db.prepare("UPDATE submissions SET status='Processing' WHERE id=?").run(+req.params.id);
  setImmediate(() => runPipeline(+req.params.id, { reuse: !!(req.body && req.body.reuse) }));
  res.json({ ok: true });
});

app.post('/api/submissions/:id/decision', (req, res) => {
  const r = db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status === 'Processing') return res.status(409).json({ error: 'Still processing' });
  if (r.decision) return res.status(409).json({ error: 'A decision is already recorded.' });
  const { outcome, note = '', underwriter = 'Underwriter' } = req.body || {};
  if (!['Quote', 'Refer', 'Decline', 'Need Info'].includes(outcome)) return res.status(400).json({ error: 'Invalid outcome' });
  const agreed = outcome === r.recommendation;
  if (!agreed && !note.trim()) return res.status(400).json({ error: 'A reason is required when overriding the AI recommendation.' });
  const risk = J(r.risk), ap = J(r.appetite), ts = new Date().toISOString();
  const decision = { outcome, note: note.trim(), underwriter, agreed, ts, ai_recommendation: r.recommendation, risk_score: risk?.score ?? null, risk_band: risk?.band ?? null, guideline_version: ap?.guidelines ?? null,
    minutes_to_decision: Math.round((new Date(ts) - new Date(r.created_at)) / 6000) / 10 };
  db.prepare('UPDATE submissions SET decision=?, status=? WHERE id=?').run(JSON.stringify(decision), 'Decided', r.id);
  db.prepare('INSERT INTO audit (submission_id, ts, agent, status, detail) VALUES (?,?,?,?,?)').run(r.id, ts, underwriter, 'done',
    agreed ? `Approved AI recommendation: ${outcome} (guidelines v${decision.guideline_version}).` : `Overrode AI recommendation (${r.recommendation} -> ${outcome}). Reason: ${note.trim()}`);
  res.json(decision);
});

app.get('/api/submissions/:id/record', (req, res) => {
  const r = db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const h = hydrate(r);
  const rec = { record_type: 'SubmissionIQ decision record', generated_at: new Date().toISOString(), submission: { id: r.id, insured: r.insured, source: r.source_name, received_at: r.created_at, processing_ms: r.processing_ms,
      documents: db.prepare('SELECT id, name, kind, pages, scanned FROM documents WHERE submission_id=?').all(r.id) },
    ai_recommendation: { outcome: r.recommendation, quality_score: r.score, property_risk: h.risk && { score: h.risk.score, band: h.risk.band, drivers: h.risk.drivers, factors: h.risk.factors }, engine: r.provider },
    guideline_version: h.appetite?.guidelines, checks: trace(h.extracted, h.evidence, h.appetite?.checks), valuation: h.valuation, location_hazards: h.hazards, extracted_fields: h.extracted, field_evidence: h.evidence, cross_document_conflicts: h.meta?.list || [],
    human_decision: h.decision, audit_trail: db.prepare('SELECT ts, agent, status, detail, duration_ms FROM audit WHERE submission_id=? ORDER BY id').all(r.id) };
  res.setHeader('Content-Disposition', `attachment; filename="decision-record-${r.id}.json"`);
  res.json(rec);
});

// ---------- Documents ----------
app.get('/api/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ id: d.id, name: d.name, mime: d.mime, kind: d.kind, scanned: !!d.scanned, submission_id: d.submission_id, ...J(d.content) });
});
app.get('/api/documents/:id/file', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d || !fs.existsSync(d.path)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', d.mime); res.setHeader('Content-Disposition', `inline; filename="${d.name.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); fs.createReadStream(d.path).pipe(res);
});

// ---------- Stats ----------
app.get('/api/stats', (_q, res) => {
  const rows = db.prepare('SELECT id, created_at, recommendation, status, processing_ms, extracted, validation, risk, decision FROM submissions').all().map((r) => ({ ...r, extracted: J(r.extracted), validation: J(r.validation), risk: J(r.risk), decision: J(r.decision) }));
  const done = rows.filter((r) => r.processing_ms && r.status !== 'Error'), decided = rows.filter((r) => r.decision).map((r) => r.decision);
  const avgSec = done.length ? done.reduce((s, r) => s + r.processing_ms, 0) / done.length / 1000 : 0;
  const pr = rows.map((r) => priority(r)), active = pr.filter((p) => p.needsAttention);
  res.json({
    total: rows.length, pending: rows.filter((r) => r.status === 'Pending review').length,
    byRecommendation: ['Quote', 'Refer', 'Decline', 'Need Info'].reduce((o, k) => ({ ...o, [k]: rows.filter((r) => r.recommendation === k).length }), {}),
    byRisk: ['Low', 'Moderate', 'Elevated', 'High'].reduce((o, k) => ({ ...o, [k]: rows.filter((r) => r.risk?.band === k).length }), {}),
    avgProcessingSec: +avgSec.toFixed(1), avgMinutesToDecision: decided.length ? +(decided.reduce((s, d) => s + (d.minutes_to_decision || 0), 0) / decided.length).toFixed(1) : null,
    needsAttention: active.length, critical: active.filter((p) => ['Critical', 'High'].includes(p.level)).length, slaBreached: active.filter((p) => p.slaBreached).length,
    manualMinutesAssumed: MANUAL_MINUTES, hoursSaved: +((done.length * (MANUAL_MINUTES - avgSec / 60)) / 60).toFixed(1),
    agreementRate: decided.length ? Math.round((decided.filter((d) => d.agreed).length / decided.length) * 100) : null,
    corrections: db.prepare("SELECT COUNT(*) AS n FROM audit WHERE detail LIKE 'Corrected %'").get().n
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const p = llm.provider();
  console.log(`SubmissionIQ running at http://localhost:${PORT}  [AI: ${p === 'offline' ? 'off (rules engine only, add GEMINI_API_KEY to enable)' : p + ' / ' + llm.modelName()}]  [hazard lookup: ${process.env.HAZARD_LOOKUP === 'off' ? 'off' : 'on'}]`);
});
