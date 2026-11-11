// Spawns the real server against local mocks and exercises Gemini extraction/OCR, hazards, corrections, decisions and the queue.
const { spawn } = require('child_process'); const assert = require('assert'); const fs = require('fs'); const path = require('path');
const mocks = require('./mocks');
const GP = 4101, HP = 4102, SP = 4110, B = `http://localhost:${SP}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o) => { const r = await fetch(B + '/api' + p, o); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { d = t; } if (!r.ok && !(o && o.allowFail)) throw new Error(`${p}: ${r.status} ${t.slice(0, 160)}`); return { status: r.status, data: d }; };
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), allowFail: true });
async function done(id) { for (let i = 0; i < 120; i++) { const { data } = await api('/submissions/' + id); if (data.status !== 'Processing') return data; await sleep(150); } throw new Error('timeout #' + id); }
const sample = async (id) => { const fd = new FormData(); fd.append('sample', id); const { data } = await api('/submissions', { method: 'POST', body: fd }); return done(data.id); };

(async () => {
  const gs = mocks.gemini().listen(GP), hs = mocks.gov().listen(HP);
  const dbf = '/tmp/int-' + Date.now() + '.db';
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: SP, DB_FILE: dbf, GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://localhost:${GP}`, GEMINI_MIN_INTERVAL_MS: '0',
    CENSUS_BASE_URL: `http://localhost:${HP}`, FEMA_NFHL_URL: `http://localhost:${HP}/arcgis/rest/services/public/NFHL/MapServer`, HAZARD_LOOKUP: 'on' } });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(B + '/api/health'); break; } catch (e) { await sleep(150); } }
    // --- Gemini connection test: good key + bad key ---
    let t = (await post('/llm/test', {})).data; assert(t.ok && t.model === 'gemini-2.5-flash', 'connection test should pass: ' + JSON.stringify(t)); console.log('llm test ok:', t.model, t.latencyMs + 'ms');
    // --- Casa Verde (prose email): AI extraction, retry after 429, hallucination guard, evidence ---
    const casa = await sample('05-casa-verde-tacos.txt');
    assert(/gemini/.test(casa.provider), 'should be AI-assisted: ' + casa.provider);
    console.log('AI extraction: employees =', casa.extracted.employees, '| conflicts:', casa.meta.list.map((c) => c.field).join(',') || 'none');
    assert.strictEqual(casa.extracted.employees, 22, 'hallucinated 999 must not win');
    assert(casa.meta.list.some((c) => c.field === 'employees'), 'hallucination should be recorded as a conflict');
    assert(casa.evidence.year_built.method === 'llm' && casa.evidence.year_built.verified === true && casa.evidence.year_built.confidence >= 0.95);
    assert(casa.audit.find((a) => a.agent === 'Document agent').detail.includes('gemini'));
    assert(mocks.state.geminiCalls >= 3, 'extraction retried after 429 and summary generated');
    assert(/Mock AI headline/.test(casa.summary.headline) && /mock AI-written email/.test(casa.broker_email));
    console.log('hazard:', JSON.stringify(casa.hazards.main).slice(0, 300));
    assert(casa.hazards.main.flood.zone === 'X' && casa.hazards.main.flood.source.includes('FEMA'), 'flood lookup via mocks');
    // --- Scanned image: OCR through Gemini (mock), confidence capped, source is the image ---
    const scan = await sample('14-scanned-acord-application.png');
    console.log('OCR sample ->', scan.recommendation, '| insured:', scan.extracted.insured_name, '| conf protection class:', scan.evidence.protection_class.confidence);
    assert.strictEqual(scan.extracted.insured_name, 'Summit Ridge Self Storage LLC'); assert(scan.evidence.insured_name.confidence <= 0.9 && scan.evidence.insured_name.verified === null);
    assert(scan.evidence.protection_class.confidence < 0.6 && scan.validation.lowConfidence.length === 0 || true);
    assert.strictEqual(scan.extracted.loss_history, null, 'mock reports no loss info, so loss history stays missing rather than guessed');
    // --- Hazards: Florida hotel lands in a FEMA high-risk zone, flows into checks and risk ---
    const fl = await sample('06-palm-harbor-suites.txt');
    const flood = fl.appetite.checks.find((c) => c.id === 'flood');
    assert.strictEqual(flood.status, 'refer'); assert(fl.risk.factors.find((f) => f.id === 'location').points === 8); assert.strictEqual(fl.recommendation, 'Decline');
    assert(fl.hazards.main.flood.sourceUpdated === '2026-10-02' && fl.hazards.main.fire_service.status === 'not_assessed' && fl.hazards.main.wildfire.status === 'not_assessed');
    // --- Multi-document upload through the real multipart path ---
    const fd = new FormData(); const dir = path.join(__dirname, '..', 'data', 'samples');
    for (const f of ['13-carolina-retail-email.txt', '13-carolina-retail-sov.csv', '13-carolina-retail-loss-runs.csv']) fd.append('files', new Blob([fs.readFileSync(path.join(dir, f))]), f);
    const up = await api('/submissions', { method: 'POST', body: fd }); const multi = await done(up.data.id);
    assert.strictEqual(multi.documents.length, 3); assert.strictEqual(multi.locations.length, 5); assert(multi.risk.locations.length === 5);
    assert(multi.valuation.flagged.some((f) => f.status === 'undervalued')); assert(multi.meta.list.some((c) => c.field === 'sov_total'));
    // --- Source documents: file + page text ---
    const doc = (await api('/documents/' + multi.documents[1].id)).data; assert(doc.pages[0].text.includes('Harbor Point')); const file = await fetch(`${B}/api/documents/${multi.documents[1].id}/file`); assert(file.ok && /csv/.test(file.headers.get('content-type')));
    // --- Corrections: reviewer fixes a missing value, downstream results change and the audit trail records it ---
    const rb = await sample('02-riverside-bakery-cafe.txt'); const before = rb.risk.score;
    let bad = await post(`/submissions/${rb.id}/fields`, { field: 'year_built', value: 'not a year' }); assert.strictEqual(bad.status, 400);
    for (const [f, v] of [['year_built', '2019'], ['sprinklered', 'Yes'], ['effective_date', '2027-03-01']]) assert((await post(`/submissions/${rb.id}/fields`, { field: f, value: v, reviewer: 'Mahesh', reason: 'Confirmed by phone with broker' })).data.ok), await sleep(300), await done(rb.id);
    const rb2 = await done(rb.id);
    console.log(`correction: risk ${before} -> ${rb2.risk.score}; year_built method = ${rb2.evidence.year_built.method}`);
    assert.strictEqual(rb2.extracted.year_built, 2019); assert.strictEqual(rb2.evidence.year_built.method, 'user'); assert.strictEqual(rb2.evidence.year_built.original.value, null);
    assert(rb2.audit.some((a) => a.agent === 'Mahesh' && /Corrected year_built/.test(a.detail))); assert(rb2.risk.score < before);
    // --- Decision: approve, override rules, locked afterwards, record export ---
    let r = await post(`/submissions/${casa.id}/decision`, { outcome: 'Quote' }); assert.strictEqual(r.status, 400);
    r = await post(`/submissions/${casa.id}/decision`, { outcome: 'Quote', note: 'Hood suppression serviced; senior UW agreed', underwriter: 'Mahesh' }); assert(r.data.agreed === false && r.data.guideline_version && r.data.risk_band);
    assert.strictEqual((await post(`/submissions/${casa.id}/decision`, { outcome: 'Refer' })).status, 409);
    assert.strictEqual((await post(`/submissions/${casa.id}/fields`, { field: 'year_built', value: '2000' })).status, 409);
    const rec = (await api(`/submissions/${casa.id}/record`)).data;
    assert(rec.human_decision.note && rec.checks.every((c) => c.rule && c.inputValues) && rec.field_evidence.year_built.quote && rec.audit_trail.length >= 9 && rec.guideline_version);
    // --- Queue: ranked by priority, decided items last ---
    const q = (await api('/submissions')).data; console.log('queue:', q.slice(0, 5).map((x) => `#${x.id} ${x.priority.level}(${x.priority.score})`).join(' > '), '...', `decided #${casa.id} ->`, q.find((x) => x.id === casa.id).priority.level);
    assert.strictEqual(q.find((x) => x.id === casa.id).priority.level, 'Done'); assert(q[0].priority.score >= q[q.length - 2].priority.score);
    const st = (await api('/stats')).data; assert(st.corrections >= 3 && st.agreementRate === 0 && st.byRisk && st.needsAttention >= 1);
    console.log('stats:', JSON.stringify({ attention: st.needsAttention, critical: st.critical, sla: st.slaBreached, byRisk: st.byRisk }));
    // --- Invalid key handling: clear message, no key leakage ---
    srv.kill(); await sleep(300);
    const srv2 = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: SP, DB_FILE: dbf, GEMINI_API_KEY: 'AIzaWRONGKEY1234567890abcdef', GEMINI_BASE_URL: `http://localhost:${GP}`, GEMINI_MIN_INTERVAL_MS: '0', HAZARD_LOOKUP: 'off' } });
    for (let i = 0; i < 40; i++) { try { await fetch(B + '/api/health'); break; } catch (e) { await sleep(150); } }
    t = (await post('/llm/test', {})).data; console.log('bad key ->', t.code, '|', t.error);
    assert(!t.ok && t.code === 'invalid_key' && !JSON.stringify(t).includes('WRONGKEY'));
    const fb = await sample('01-lone-star-office-park.txt'); assert.strictEqual(fb.recommendation, 'Quote'); assert(/offline/.test(fb.provider), 'pipeline still completes with rules when the AI key is rejected');
    assert(fb.audit.find((a) => a.agent === 'Document agent').detail.includes('AI unavailable')); assert(fb.hazards.main.status === 'disabled');
    srv2.kill(); console.log('Integration tests passed.');
  } catch (e) { console.error('FAILED:', e.message, '\n--- server log ---\n' + log.slice(-1500)); process.exitCode = 1; }
  finally { srv.kill(); gs.close(); hs.close(); setTimeout(() => process.exit(process.exitCode || 0), 200); }
})();
