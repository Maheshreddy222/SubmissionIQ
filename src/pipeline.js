// 8-step agent pipeline. Every step is logged to the audit table so the UI shows live progress.
const db = require('./db');
const llm = require('./llm');
const E = require('./engine');
const { offlineCandidates, merge, one } = require('./intake');
const { llmExtract } = require('./llmExtract');
const { screenAll, loadValuation } = require('./valuation');
const { scoreAccount, loadModel } = require('./risk');
const hazards = require('./hazards');

const now = () => new Date().toISOString();
const short = (m) => String(m).replace(/\s+/g, ' ').slice(0, 140);
const J = (s) => (s ? JSON.parse(s) : null);

async function step(id, agent, fn) {
  const t0 = Date.now();
  const rid = db.prepare('INSERT INTO audit (submission_id, ts, agent, status) VALUES (?,?,?,?)').run(id, now(), agent, 'running').lastInsertRowid;
  try {
    const { value, detail } = await fn();
    db.prepare('UPDATE audit SET status=?, detail=?, duration_ms=? WHERE id=?').run('done', detail, Date.now() - t0, rid);
    return value;
  } catch (e) {
    db.prepare('UPDATE audit SET status=?, detail=?, duration_ms=? WHERE id=?').run('error', short(e.message), Date.now() - t0, rid);
    throw e;
  }
}

function loadDocs(id) {
  return db.prepare('SELECT * FROM documents WHERE submission_id=? ORDER BY id').all(id).map((r) => ({ id: r.id, name: r.name, mime: r.mime, kind: r.kind, scanned: !!r.scanned, path: r.path, ...J(r.content) }));
}

const SUMMARY_SYSTEM = `You assist a commercial property underwriter. You receive extracted submission data, document evidence, guideline checks (with rules), a property risk score with factor breakdown, a replacement-cost screening, a flood hazard result and a recommendation.
The recommendation and risk score were produced by deterministic rules. Explain them; do NOT change them. Use only facts present in the input and never invent numbers or sources.
Cite guideline references like (§6.1) in concerns. Mention the property risk score and its top drivers. Treat valuation as a screening estimate, not a certified valuation.
Return JSON: headline (one sentence), summary (3-4 sentences), strengths (max 4), concerns (max 6), broker_questions (specific, empty if none), broker_email (plain text, under 170 words, signed "Underwriting Team", matching the recommendation).`;
const SUMMARY_SCHEMA = { type: 'OBJECT', properties: { headline: { type: 'STRING' }, summary: { type: 'STRING' }, strengths: { type: 'ARRAY', items: { type: 'STRING' } }, concerns: { type: 'ARRAY', items: { type: 'STRING' } },
  broker_questions: { type: 'ARRAY', items: { type: 'STRING' } }, broker_email: { type: 'STRING' } }, required: ['headline', 'summary', 'strengths', 'concerns', 'broker_questions', 'broker_email'] };

const FOLLOW_UP = {
  class: 'Please describe operations in detail (hazards, housekeeping, cooking or hot-work controls, and fire suppression).', age: 'Please provide the update years for roof, electrical, plumbing and HVAC.',
  construction: 'Please confirm sprinkler status and any planned fire-protection upgrades.', sprinkler: 'Please confirm sprinkler coverage and provide the latest inspection report.',
  losses: 'Please provide currently valued loss runs and the corrective actions taken after each loss.', tiv: 'Please provide a current schedule of values and valuation basis.',
  experience: 'Please provide the management team background and prior operating history.', ppc: 'Please confirm distance to the nearest fire station and hydrant.',
  valuation: 'Please provide a recent replacement-cost valuation or appraisal for the building.', flood: 'Please provide flood zone determination, elevation certificate and flood coverage details.'
};

function offlineSummary(ex, v, checks, rec, risk, val) {
  const pass = checks.filter((c) => c.status === 'pass'), bad = checks.filter((c) => ['refer', 'decline'].includes(c.status));
  const headlines = { Quote: 'Within appetite and authority - ready to quote.', Refer: 'Writable, but referral triggers apply - send to a senior underwriter.', Decline: 'Outside carrier appetite - recommend declining.', 'Need Info': 'Critical information is missing - request it before assessing the risk.' };
  const drivers = (risk.drivers || []).map((d) => `${d.label.toLowerCase()}`).join(', ');
  return {
    headline: headlines[rec],
    summary: `${ex.insured_name || 'This account'} (${ex.class_of_business || 'class unknown'}${ex.state ? ', ' + ex.state : ''}) is ${v.completeness}% complete with a property risk score of ${risk.score ?? 'n/a'} (${risk.band}).${drivers ? ` Main risk drivers: ${drivers}.` : ''} ${pass.length} of ${checks.length} guideline checks passed${bad.length ? `; ${bad.length} raised flags` : ''}. Recommendation: ${rec}.`,
    strengths: pass.slice(0, 4).map((c) => c.detail),
    concerns: [...bad, ...checks.filter((c) => c.status === 'unknown')].slice(0, 6).map((c) => `${c.detail} (${c.ref})`),
    broker_questions: [...v.criticalMissing.map((m) => `Please provide: ${m.label}.`), ...bad.filter((c) => c.status === 'refer').map((c) => FOLLOW_UP[c.id]).filter(Boolean)]
  };
}
function offlineEmail(ex, v, summary, rec) {
  const hi = 'Hi,\n\n', sig = '\n\nBest regards,\nUnderwriting Team', who = ex.insured_name || 'your submission';
  if (rec === 'Decline') return `${hi}Thank you for submitting ${who}. After review, we are unable to offer terms on this risk as it falls outside our current appetite:\n\n${summary.concerns.map((c) => '- ' + c).join('\n')}\n\nWe appreciate the opportunity and welcome future submissions.${sig}`;
  if (rec === 'Need Info') return `${hi}Thank you for submitting ${who}. To complete our review, please send the following:\n\n${summary.broker_questions.map((q) => '- ' + q.replace(/^Please provide: /, '')).join('\n')}\n\nOnce received, we will turn this around promptly.${sig}`;
  if (rec === 'Refer') return `${hi}Thank you for submitting ${who}. The risk is under review with our senior underwriting team. To help us move quickly, please confirm:\n\n${(summary.broker_questions.length ? summary.broker_questions : summary.concerns).map((q) => '- ' + q).join('\n')}\n\nWe will update you shortly.${sig}`;
  return `${hi}Thank you for submitting ${who}. The risk is within our appetite and we are preparing terms. We will send the quote shortly. Please let us know of any changes before the effective date${ex.effective_date ? ` (${ex.effective_date})` : ''}.${sig}`;
}

// ---- Step 1 helper: choose deterministic vs AI extraction per document ----
async function extractDocuments(docs, prov) {
  const acc = { cands: [], losses: [], locations: [], declaredTotal: null };
  const llmDocs = [], offlineByKey = {}, textOff = [];
  for (const d of docs) {
    const r = offlineCandidates(d);
    if (r.parsedTable) { acc.cands.push(...r.cands); acc.losses.push(...r.losses); acc.locations.push(...r.locations); acc.declaredTotal = r.declaredTotal ?? acc.declaredTotal; continue; }
    d._off = r; textOff.push(d);
    for (const c of r.cands) offlineByKey[`${d.id}|${c.page}|${c.field}`] = one(c.field, c.raw);
    if (d.scanned || prov !== 'offline') llmDocs.push(d);
  }
  const unread = []; let how = 'rules-based extraction', info = null, lossInfoProvided = false, error = null;
  const useOffline = (d) => { acc.cands.push(...d._off.cands); acc.losses.push(...d._off.losses); };
  if (llmDocs.length && prov !== 'offline') {
    try {
      info = await llmExtract(llmDocs, offlineByKey);
      acc.cands.push(...info.cands); acc.locations.push(...info.locations); lossInfoProvided = info.lossInfoProvided; how = `${prov} ${info.model}${info.cached ? ' (cached)' : ''}`;
      const llmFields = new Set(info.cands.map((c) => c.field));
      acc.losses.push(...info.losses);
      for (const d of textOff) {
        if (!llmDocs.includes(d)) { useOffline(d); continue; }
        acc.cands.push(...d._off.cands.filter((c) => !llmFields.has(c.field)));
        if (!info.losses.length) acc.losses.push(...d._off.losses);
      }
      for (const dk of info.docKinds || []) { const d = docs.find((x) => x.name === dk.name); if (d && d.kind === 'other' && /^(email|acord|sov|loss_run)$/.test(dk.type)) { d.kind = dk.type; db.prepare('UPDATE documents SET kind=? WHERE id=?').run(dk.type, d.id); } }
    } catch (e) {
      error = e; how = `rules-based extraction (AI unavailable: ${short(e.message)})`;
      for (const d of textOff) { if (d.scanned) unread.push(d); else useOffline(d); }
    }
  } else for (const d of textOff) { if (d.scanned) unread.push(d); else useOffline(d); }
  const out = merge({ docs, ...acc, lossInfoProvided });
  return { ...out, unread, how, info, error, usedLLM: !!info };
}

async function runPipeline(id, opts = {}) {
  const t0 = Date.now();
  const row = db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
  const prov = llm.provider(), label = `${prov} ${llm.modelName()}`;
  let usedLLM = false;
  db.prepare("UPDATE submissions SET status='Processing' WHERE id=?").run(id);
  try {
    const docs = loadDocs(id);
    // 1. Document agent
    let intake;
    if (opts.reuse) {
      const meta = J(row.conflicts) || {};
      intake = await step(id, 'Document agent', async () => ({ value: { extracted: J(row.extracted), evidence: J(row.evidence) || {}, conflicts: meta.list || [], locations: J(row.locations) || [], declaredTotal: meta.declaredTotal || null, unread: meta.unread || [] }, detail: 'Reused the existing extraction with reviewer corrections applied.' }));
      usedLLM = /gemini|anthropic/.test(row.provider || '');
    } else {
      intake = await step(id, 'Document agent', async () => {
        const r = await extractDocuments(docs, prov);
        const ev = Object.values(r.evidence), high = ev.filter((e) => e.confidence >= 0.85).length;
        const kinds = [...new Set(docs.map((d) => d.kind))].join(', ');
        const detail = `Read ${docs.length} document${docs.length === 1 ? '' : 's'} (${kinds}); ${ev.length} fields with source evidence (${high} high-confidence), ${r.locations.length || 1} location${r.locations.length > 1 ? 's' : ''}, ${(r.extracted.loss_history || []).length} losses, using ${r.how}.${r.unread.length ? ` ${r.unread.length} scanned file(s) could not be read offline.` : ''}${r.info?.notes?.unverified ? ` ${r.info.notes.unverified} value(s) unverified.` : ''}`;
        return { value: r, detail };
      });
      usedLLM = intake.usedLLM;
      db.prepare('UPDATE submissions SET extracted=?, evidence=?, locations=?, conflicts=?, insured=? WHERE id=?')
        .run(JSON.stringify(intake.extracted), JSON.stringify(intake.evidence), JSON.stringify(intake.locations), JSON.stringify({ list: intake.conflicts, unread: intake.unread.map((d) => ({ id: d.id, name: d.name })), declaredTotal: intake.declaredTotal }), intake.extracted.insured_name, id);
    }
    const ex = intake.extracted, evidence = intake.evidence, locations = intake.locations || [];
    const unread = (intake.unread || []).map((d) => ({ id: d.id, name: d.name }));

    // 2. Validation agent
    const v = await step(id, 'Validation agent', async () => {
      const value = E.validate(ex, { evidence, conflicts: intake.conflicts, unread });
      return { value, detail: `${value.completeness}% complete; ${value.criticalMissing.length} critical field(s) missing; ${value.flags.length} data-quality flag(s); ${intake.conflicts.length} cross-document conflict(s).` };
    });

    // 3. Location agent (FEMA flood hazard via address)
    const hz = await step(id, 'Location agent', async () => {
      const main = await hazards.lookup(ex.address); const byLoc = {};
      if (locations.length > 1) for (const l of [...locations].sort((a, b) => b.tiv - a.tiv).slice(0, 6)) byLoc[l.loc_no] = l.address === ex.address ? main : await hazards.lookup(l.address);
      const f = main.flood;
      const detail = main.status === 'ok' ? `FEMA flood zone ${f.zone || 'not mapped'} (${f.level || 'unclassified'}) from ${f.source}, retrieved ${f.retrieved}.${main.cached ? ' (cached)' : ''}` : main.status === 'disabled' ? 'Location lookup is switched off (HAZARD_LOOKUP=off).' : `Not assessed: ${main.error || main.status}.`;
      return { value: { main, byLoc: Object.keys(byLoc).length ? byLoc : null }, detail };
    });
    db.prepare('UPDATE submissions SET hazards=? WHERE id=?').run(JSON.stringify(hz), id);

    // 4. Valuation agent
    const val = await step(id, 'Valuation agent', async () => {
      const value = screenAll(ex, locations, loadValuation());
      return { value, detail: value.status === 'not_assessed' ? value.summary : `${value.summary} (screening estimate)` };
    });

    // 5. Risk scoring agent
    const risk = await step(id, 'Risk scoring agent', async () => {
      const value = scoreAccount(ex, { evidence, hazard: hz.main, valuation: val, valuationByLoc: val.byLocation, hazardByLoc: hz.byLoc }, locations, loadModel());
      return { value, detail: `Property risk score ${value.score ?? 'n/a'} (${value.band}) from ${value.assessed} of ${value.total} factors${value.drivers.length ? `; drivers: ${value.drivers.map((d) => d.label).join(', ')}` : ''}.` };
    });
    db.prepare('UPDATE submissions SET risk=?, valuation=? WHERE id=?').run(JSON.stringify(risk), JSON.stringify(val), id);

    // 6. Appetite agent
    const g = E.loadGuidelines();
    const { checks, rec, quality } = await step(id, 'Appetite agent', async () => {
      const checks = E.evaluateAppetite(ex, g, { valuation: val, hazard: hz.main });
      const d = E.decide(v, checks, ex); const c = (s) => checks.filter((x) => x.status === s).length;
      db.prepare('UPDATE submissions SET recommendation=?, score=?, validation=?, appetite=? WHERE id=?')
        .run(d.recommendation, d.score, JSON.stringify(v), JSON.stringify({ guidelines: g.version, checks }), id);
      return { value: { checks, rec: d.recommendation, quality: d.score }, detail: `${c('pass')} pass, ${c('refer')} refer, ${c('decline')} decline, ${c('unknown')} unknown -> ${d.recommendation} (guidelines v${g.version}).` };
    });

    // 7. Risk summary agent (one AI call writes the summary and the broker email)
    const base = offlineSummary(ex, v, checks, rec, risk, val);
    const summary = await step(id, 'Risk summary agent', async () => {
      let ai = null, how = 'offline template';
      if (prov !== 'offline') {
        try {
          const r = await llm.generateJSON({ system: SUMMARY_SYSTEM, schema: SUMMARY_SCHEMA, cacheKey: 'summary', maxOutputTokens: 4096,
            validate: (d) => { for (const k of ['headline', 'summary']) if (typeof d[k] !== 'string' || d[k].length < 10) throw new Error(`${k} missing`); for (const k of ['strengths', 'concerns', 'broker_questions']) if (!Array.isArray(d[k])) throw new Error(`${k} must be an array`); if (typeof d.broker_email !== 'string' || d.broker_email.length < 40) throw new Error('broker_email missing'); },
            parts: [{ text: JSON.stringify({ recommendation: rec, extracted: { ...ex, loss_history: (ex.loss_history || []).map(({ source, ...l }) => l) }, completeness: v.completeness, missing_fields: v.missing.map((m) => m.label), data_flags: v.flags.map((f) => f.text),
              guideline_checks: checks.map((c) => ({ check: c.name, status: c.status, detail: c.detail, ref: c.ref, rule: c.rule })), property_risk: { score: risk.score, band: risk.band, factors: risk.factors.map((f) => ({ factor: f.label, points: f.points, max: f.max, reason: f.reason, assumed: f.assumed })) },
              valuation_screening: { status: val.status, summary: val.summary }, flood: hz.main.flood ? { zone: hz.main.flood.zone, description: hz.main.flood.description } : { status: hz.main.status }, conflicts: intake.conflicts.map((c) => c.field) }) }] });
          ai = r.data; how = `${prov} ${r.model}${r.cached ? ' (cached)' : ''}`; usedLLM = true;
        } catch (e) { how = `offline template (AI unavailable: ${short(e.message)})`; }
      }
      return { value: { ...base, ...(ai ? { headline: ai.headline, summary: ai.summary, strengths: ai.strengths, concerns: ai.concerns, broker_questions: ai.broker_questions, broker_email: ai.broker_email } : {}) }, detail: `Wrote risk summary using ${how}.` };
    });

    // 8. Broker communication agent
    const email = await step(id, 'Broker communication agent', async () => {
      const value = summary.broker_email || offlineEmail(ex, v, summary, rec);
      return { value, detail: `Drafted ${rec.toLowerCase()} email to broker${summary.broker_email ? ' with AI' : ' from template'}.` };
    });
    const { broker_email, ...sum } = summary;
    db.prepare('UPDATE submissions SET summary=?, broker_email=?, status=?, provider=?, processing_ms=? WHERE id=?')
      .run(JSON.stringify(sum), email, 'Pending review', usedLLM ? label : 'offline rules engine', (row.processing_ms && opts.reuse ? row.processing_ms : 0) + (Date.now() - t0), id);
  } catch (e) {
    db.prepare('UPDATE submissions SET status=?, processing_ms=? WHERE id=?').run('Error', Date.now() - t0, id);
    console.error(`Pipeline failed for #${id}:`, e);
  }
}
module.exports = { runPipeline, loadDocs };
