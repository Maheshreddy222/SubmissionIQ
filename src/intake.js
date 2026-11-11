// Turns a set of documents into one extracted record with per-field evidence (source document, page, quote, confidence).
const { offlineExtract, normalize } = require('./extract');
const T = require('./tabular');

const RANK = { acord: 3, sov: 3, loss_run: 3, email: 2, other: 1 };
const SCALAR = ['insured_name', 'address', 'class_of_business', 'years_in_business', 'annual_revenue', 'employees', 'construction', 'year_built', 'stories', 'square_feet',
  'sprinklered', 'protection_class', 'tiv_building', 'tiv_contents', 'tiv_bi', 'effective_date', 'prior_carrier', 'coverages_requested'];
const LABEL_CONF = 0.93, PROSE_CONF = 0.7;
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9$.%]+/g, ' ').trim();
const lineFor = (text, raw) => {
  const r = String(raw).toLowerCase();
  const l = text.split(/\r?\n/).find((x) => x.toLowerCase().includes(r));
  return l ? l.trim().slice(0, 160) : '';
};
const one = (field, raw) => normalize({ [field]: raw })[field];
const sane = (f, v) => {
  if (v === null || v === undefined || v === '') return false;
  if (f === 'year_built') return v >= 1700 && v <= new Date().getFullYear() + 2;
  if (['square_feet', 'stories', 'employees'].includes(f)) return v > 0;
  if (['tiv_building', 'tiv_contents', 'tiv_bi', 'annual_revenue'].includes(f)) return v >= 0;
  if (f === 'protection_class') return v >= 1 && v <= 10;
  return true;
};

// ---- Offline candidates from text pages and spreadsheets ----
function offlineCandidates(doc) {
  const cands = [], losses = [], locations = []; let declaredTotal = null, parsedTable = false;
  for (const tb of doc.tables || []) {
    const kind = T.detectTable(tb.rows);
    if (kind === 'sov') {
      const r = T.mapSOV(tb.rows);
      if (r) { parsedTable = true; declaredTotal = r.declaredTotal ?? declaredTotal; for (const l of r.locations) locations.push({ ...l, source: { docId: doc.id, doc: doc.name, page: tb.page, row: l.row, quote: tb.rows[l.row - 1]?.join(' | ').slice(0, 160) } }); }
    } else if (kind === 'loss_run') {
      const r = T.mapLossRun(tb.rows);
      if (r) { parsedTable = true; for (const l of r.losses) losses.push({ ...l, source: { docId: doc.id, doc: doc.name, page: tb.page, row: l.row, quote: tb.rows[l.row - 1]?.join(' | ').slice(0, 160) } }); doc.lossRunParsed = true; }
    }
  }
  if (!parsedTable && !doc.scanned) {
    for (const p of doc.pages) {
      if (!p.text) continue;
      const raw = offlineExtract(p.text), methods = raw.__methods || {};
      for (const f of SCALAR) {
        if (raw[f] === null || raw[f] === undefined) continue;
        cands.push({ field: f, raw: raw[f], docId: doc.id, doc: doc.name, kind: doc.kind, page: p.n, quote: lineFor(p.text, raw[f]), method: methods[f] || 'label',
          confidence: (methods[f] || 'label') === 'label' ? LABEL_CONF : (f === 'class_of_business' || f === 'insured_name' ? 0.5 : PROSE_CONF) });
      }
      if (Array.isArray(raw.loss_history)) {
        for (const l of raw.loss_history) losses.push({ ...l, source: { docId: doc.id, doc: doc.name, page: p.n, quote: lineFor(p.text, String(l.paid).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) || lineFor(p.text, l.cause) } });
        if (!raw.loss_history.length) cands.push({ field: 'loss_history', raw: [], docId: doc.id, doc: doc.name, kind: doc.kind, page: p.n, quote: lineFor(p.text, 'no ') , method: 'label', confidence: 0.8 });
      }
    }
  }
  return { cands, losses, locations, declaredTotal, parsedTable };
}

// ---- Merge candidates across documents ----
function merge({ docs, cands, losses, locations, declaredTotal, lossInfoProvided }) {
  const extracted = {}, evidence = {}, conflicts = [];
  const byField = {};
  for (const c of cands) {
    if (c.field === 'loss_history') continue;
    const v = c.value !== undefined ? c.value : one(c.field, c.raw);
    if (!sane(c.field, v)) continue;
    (byField[c.field] ||= []).push({ ...c, value: v });
  }
  for (const [f, list] of Object.entries(byField)) {
    list.sort((a, b) => (RANK[b.kind] || 1) - (RANK[a.kind] || 1) || b.confidence - a.confidence);
    const w = list[0]; extracted[f] = w.value;
    evidence[f] = { value: w.value, docId: w.docId, doc: w.doc, page: w.page, quote: w.quote || '', method: w.method, confidence: +w.confidence.toFixed(2), verified: w.verified ?? null, note: w.note || null };
    const others = list.filter((x) => JSON.stringify(x.value) !== JSON.stringify(w.value));
    if (others.length) conflicts.push({ field: f, chosen: { value: w.value, doc: w.doc, page: w.page }, others: others.map((x) => ({ value: x.value, doc: x.doc, page: x.page })) });
  }
  // Locations from schedules of values: account totals + primary location
  if (locations.length) {
    const sum = (k) => locations.reduce((s, l) => s + (l[k] || 0), 0);
    const primary = [...locations].sort((a, b) => b.tiv - a.tiv)[0];
    for (const [f, k] of [['tiv_building', 'tiv_building'], ['tiv_contents', 'tiv_contents'], ['tiv_bi', 'tiv_bi']]) {
      const total = sum(k); if (!total && extracted[f] !== undefined) continue;
      if (extracted[f] !== undefined && extracted[f] !== total) conflicts.push({ field: f, chosen: { value: total, doc: primary.source.doc, page: primary.source.page }, others: [{ value: extracted[f], doc: evidence[f]?.doc, page: evidence[f]?.page }] });
      extracted[f] = total; evidence[f] = { value: total, docId: primary.source.docId, doc: primary.source.doc, page: primary.source.page, quote: `Sum of ${locations.length} locations in schedule of values`, method: 'sov', confidence: 0.95, verified: true };
    }
    const fill = { address: 'address', class_of_business: 'class_of_business', construction: 'construction', year_built: 'year_built', stories: 'stories', square_feet: 'square_feet', sprinklered: 'sprinklered', protection_class: 'protection_class' };
    for (const f of Object.keys(fill)) {
      const v = primary[f]; if (v === null || v === undefined || v === '') continue;
      if (extracted[f] === undefined || (f === 'class_of_business' && evidence[f]?.method === 'prose') || (locations.length > 1 && ['address', 'construction', 'year_built', 'stories', 'square_feet', 'sprinklered', 'protection_class'].includes(f))) {
        extracted[f] = v; evidence[f] = { value: v, docId: primary.source.docId, doc: primary.source.doc, page: primary.source.page, quote: primary.source.quote || '', method: 'sov', confidence: 0.92, verified: true, note: locations.length > 1 ? `Primary (highest-value) location of ${locations.length}` : null };
      }
    }
    if (declaredTotal && Math.abs(declaredTotal - sum('tiv')) > Math.max(1000, sum('tiv') * 0.005))
      conflicts.push({ field: 'sov_total', chosen: { value: sum('tiv'), doc: primary.source.doc, page: primary.source.page }, others: [{ value: declaredTotal, doc: primary.source.doc, page: primary.source.page, label: 'declared total row' }], note: 'Schedule of values total does not match the sum of its rows' });
  }
  // Loss history: prefer loss-run documents, otherwise first document that provided any
  let lh = null, lhSrc = null;
  const fromLossRun = losses.filter((l) => docs.find((d) => d.id === l.source?.docId)?.kind === 'loss_run');
  const pool = fromLossRun.length ? fromLossRun : losses;
  if (pool.length) {
    const seen = new Set(); lh = [];
    for (const l of pool) { const k = l.claim_no || `${l.year}|${l.cause}|${l.paid}`; if (seen.has(k)) continue; seen.add(k); lh.push(l); }
    lhSrc = pool[0].source;
  } else if (cands.some((c) => c.field === 'loss_history') || lossInfoProvided) {
    lh = []; const c = cands.find((x) => x.field === 'loss_history'); lhSrc = c ? { docId: c.docId, doc: c.doc, page: c.page, quote: c.quote } : null;
  }
  extracted.loss_history = lh;
  if (lh !== null) evidence.loss_history = { value: `${lh.length} loss${lh.length === 1 ? '' : 'es'}`, docId: lhSrc?.docId, doc: lhSrc?.doc, page: lhSrc?.page, quote: lhSrc?.quote || '', method: fromLossRun.length ? 'loss_run' : 'label', confidence: fromLossRun.length ? 0.95 : 0.85, verified: true };
  const base = normalize({ ...extracted, loss_history: lh });
  if (base.address && (!base.city || !base.state)) Object.assign(base, normalize({ address: base.address }), { address: base.address });
  const out = normalize({ ...base, loss_history: lh });
  out.loss_history = lh === null ? null : lh.map((l) => ({ year: l.year, cause: l.cause, paid: l.paid, status: l.status || null, reserve: l.reserve || 0, source: l.source || null }));
  out.state = out.state || base.state;
  return { extracted: out, evidence, conflicts, locations, declaredTotal };
}

function runOffline(docs) {
  const all = { cands: [], losses: [], locations: [], declaredTotal: null };
  const unread = [];
  for (const d of docs) {
    if (d.scanned) { unread.push(d); continue; }
    const r = offlineCandidates(d);
    all.cands.push(...r.cands); all.losses.push(...r.losses); all.locations.push(...r.locations); if (r.declaredTotal) all.declaredTotal = r.declaredTotal;
  }
  return { ...merge({ docs, ...all }), unread };
}

module.exports = { runOffline, merge, offlineCandidates, SCALAR, squash, sane, one };
