const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n === null || n === undefined ? null : '$' + Math.round(n).toLocaleString('en-US'));
const cls = (r) => String(r || 'none').toLowerCase().replace(/\s+/g, '-');
const ICON = { Quote: '✓', Refer: '⚠', Decline: '✕', 'Need Info': '?' };
const COLOR = { Quote: 'var(--ok)', Refer: 'var(--warn)', Decline: 'var(--bad)', 'Need Info': 'var(--info)' };
const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const pill = (r) => `<span class="pill ${cls(r)}">${r ? ICON[r] + ' ' : ''}${esc(r || 'Processing')}</span>`;
const priPill = (p) => `<span class="pill pri-${cls(p.level)}">${esc(p.level)}${p.needsAttention ? ' · ' + p.score : ''}</span>`;
const riskPill = (r) => (r && r.score !== null && r.score !== undefined ? `<span class="pill rb-${cls(r.band)}">${esc(r.band)} · ${r.score}</span>` : '<span class="pill rb-unknown">n/a</span>');
const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const store = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch (e) { return null; } };
const app = $('#app');
let timer = null, guidelines = null, list = [];
const qs = { q: '', f: 'Needs attention' };
const FL = { insured_name: 'Insured', address: 'Location', class_of_business: 'Class', construction: 'Construction', year_built: 'Year built', stories: 'Stories', square_feet: 'Square feet', sprinklered: 'Sprinklered',
  protection_class: 'Protection class', years_in_business: 'Years in business', annual_revenue: 'Annual revenue', tiv_building: 'Building value', tiv_contents: 'Contents value', tiv_bi: 'Business income',
  effective_date: 'Effective date', prior_carrier: 'Prior carrier', loss_history: 'Loss history', state: 'State' };
const ROWS = ['insured_name', 'address', 'class_of_business', 'construction', 'year_built', 'stories', 'square_feet', 'sprinklered', 'protection_class', 'years_in_business', 'annual_revenue', 'tiv_building', 'tiv_contents', 'tiv_bi', 'effective_date', 'prior_carrier'];
const MONEY = ['annual_revenue', 'tiv_building', 'tiv_contents', 'tiv_bi'];
const cv = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
const fmt = (f, v) => (v === null || v === undefined || v === '' ? null : MONEY.includes(f) ? usd(v) : f === 'sprinklered' ? (v ? 'Yes' : 'No') : f === 'square_feet' ? Number(v).toLocaleString() : Array.isArray(v) ? v.join(', ') : String(v));

async function api(path, opts) {
  const r = await fetch('/api' + path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3000); }
function setTheme(t) { document.documentElement.dataset.theme = t; store('siq-theme', t); $('#theme').innerHTML = ic(t === 'dark' ? 'sun' : 'moon'); }
$('#theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
setTheme(document.documentElement.dataset.theme || 'dark');

// ---------- Evidence helpers ----------
let SRC = [];
function srcChip(ev) {
  if (!ev) return '';
  if (ev.method === 'user') return `<span class="src" title="Corrected by ${esc(ev.by)}${ev.quote ? ': ' + esc(ev.quote) : ''}" style="cursor:default">${ic('pencil')} ${esc(ev.by || 'Reviewer')}</span>`;
  if (!ev.docId) return ev.doc ? `<span class="src" style="cursor:default">${esc(ev.doc)}</span>` : '';
  SRC.push(ev);
  return `<button class="src" data-i="${SRC.length - 1}" title="${esc(ev.quote || 'Open source')}">${ic('file')} ${esc(ev.doc)}${ev.page ? ' · p.' + ev.page : ''}</button>`;
}
function confDot(ev) {
  if (!ev) return '';
  if (ev.method === 'user') return `<span class="conf us" title="Verified by reviewer"></span>`;
  const c = ev.confidence ?? 0, k = c >= 0.85 ? 'hi' : c >= 0.6 ? 'md' : 'lo';
  return `<span class="conf ${k}" title="${Math.round(c * 100)}% confidence${ev.verified === false ? ' · unverified' : ev.verified ? ' · verified in text' : ''}${ev.note ? ' · ' + esc(ev.note) : ''}"></span>${Math.round(c * 100)}%`;
}
async function openSource(ev) {
  const d = await api('/documents/' + ev.docId);
  const page = ev.page || 1, pg = d.pages.find((p) => p.n === page) || d.pages[0] || { text: '' };
  $('#dtitle').innerHTML = `<b>${esc(d.name)}</b><br><small class="muted">${esc(d.kind)} · ${d.pages.length} page${d.pages.length === 1 ? '' : 's'}${d.scanned ? ' · scanned' : ''}</small>`;
  let body = ev.quote ? `<div class="evquote"><small class="muted">Evidence${ev.field ? ' for ' + esc(FL[ev.field] || ev.field) : ''}</small><br>&ldquo;${esc(ev.quote)}&rdquo;${ev.note ? `<br><small class="muted">${esc(ev.note)}</small>` : ''}</div>` : '';
  const file = `/api/documents/${d.id}/file`;
  if (d.mime === 'application/pdf') body += `<iframe src="${file}#page=${page}" title="${esc(d.name)}"></iframe><p class="hint">Showing page ${page}. Use the viewer controls to move between pages.</p>`;
  else if (/^image\//.test(d.mime)) body += `<img src="${file}" alt="${esc(d.name)}">`;
  else {
    const t = pg.text || '', q = ev.quote || '', i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
    body += `<h3>${esc(pg.label || 'Page ' + page)}</h3><pre>${i >= 0 ? esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length)) : esc(t)}</pre>`;
  }
  $('#dbody').innerHTML = body; $('#drawer').hidden = false;
}
document.addEventListener('click', (e) => { const b = e.target.closest('.src[data-i]'); if (b) openSource(SRC[+b.dataset.i]).catch((err) => toast(err.message)); });
$('#dclose').onclick = () => ($('#drawer').hidden = true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) $('#drawer').hidden = true; });

function route() {
  clearTimeout(timer); clearInterval(timer);
  const h = location.hash || '#/';
  document.title = 'SubmissionIQ - Underwriting Copilot';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === h));
  window.scrollTo(0, 0); $('#drawer').hidden = true;
  app.innerHTML = '<div class="skel"></div><div class="skel" style="height:260px"></div>';
  if (h === '#/new') return newView();
  if (h === '#/guidelines') return guidelinesView();
  if (h.startsWith('#/s/')) return detailView(+h.slice(4));
  return dashboardView();
}
window.addEventListener('hashchange', route);

async function runDemo(btn) {
  btn.disabled = true;
  try {
    const featured = (await api('/samples')).filter((s) => s.featured);
    for (const s of featured) { const fd = new FormData(); fd.append('sample', s.id); await api('/submissions', { method: 'POST', body: fd }); }
    toast(`${featured.length} sample submissions are being analyzed`); dashboardView();
  } catch (e) { toast(e.message); btn.disabled = false; }
}

// ---------- Work queue ----------
const FILTERS = ['Needs attention', 'All', 'Quote', 'Refer', 'Decline', 'Need Info', 'Decided'];
function donut(o) {
  const total = Object.values(o).reduce((a, b) => a + b, 0); let acc = 0;
  const stops = Object.entries(o).filter(([, v]) => v).map(([k, v]) => { const s = acc; acc += (v / total) * 100; return `${COLOR[k]} ${s}% ${acc}%`; });
  return `<div class="donutwrap"><div class="donut" style="${total ? `background:conic-gradient(${stops.join(',')})` : ''}"><span>${total}</span></div>
    <div class="legend">${Object.entries(o).map(([k, v]) => `<div><i style="background:${COLOR[k]}"></i>${k}: <b>${v}</b></div>`).join('')}</div></div>`;
}
const statsHTML = (st) => `<div class="stat"><b>${st.needsAttention}</b><span>Need human attention</span></div><div class="stat"><b style="color:${st.critical ? 'var(--bad)' : 'inherit'}">${st.critical}</b><span>Critical / high priority</span></div>
  <div class="stat"><b style="color:${st.slaBreached ? 'var(--warn)' : 'inherit'}">${st.slaBreached}</b><span>Past review SLA</span></div><div class="stat"><b>${st.avgProcessingSec}s</b><span>Avg. AI processing<br><small>~${st.hoursSaved}h saved (assumes ${st.manualMinutesAssumed} min manual)</small></span></div>
  <div class="stat"><b>${st.avgMinutesToDecision === null ? '-' : st.avgMinutesToDecision + ' min'}</b><span>Avg. time to decision</span></div><div class="stat"><b>${st.agreementRate === null ? '-' : st.agreementRate + '%'}</b><span>Reviewer agrees with AI<br><small>${st.corrections} field correction${st.corrections === 1 ? '' : 's'}</small></span></div>`;
function tableHTML() {
  const f = qs.f, rows = list.filter((r) => (f === 'All' || (f === 'Needs attention' ? r.priority.needsAttention : f === 'Decided' ? !!r.decision : r.recommendation === f))
    && (!qs.q || `${r.insured || ''} ${r.source_name}`.toLowerCase().includes(qs.q)));
  if (!list.length) return '<p class="muted">No submissions yet.</p>';
  if (!rows.length) return '<p class="muted">Nothing here. Try another filter.</p>';
  const eff = (r) => (r.priority.dueInDays === null || r.priority.dueInDays === undefined ? '<span class="muted">-</span>' : r.priority.dueInDays < 0 ? `<b style="color:var(--bad)">${-r.priority.dueInDays} d past</b>` : `${r.priority.dueInDays} d`);
  return `<table><tr><th>Priority</th><th>Insured and why it needs attention</th><th>AI rec.</th><th>Property risk</th><th>Effective in</th><th>Waiting</th></tr>${rows.map((r) =>
    `<tr class="click" onclick="location.hash='#/s/${r.id}'"><td>${priPill(r.priority)}</td><td><b>${esc(r.insured || r.source_name)}</b> <small class="muted">#${r.id}${r.docs > 1 ? ' · ' + r.docs + ' docs' : ''}</small>
    <div class="reasons">${r.priority.reasons.slice(0, 4).map((x) => `<span>${esc(x)}</span>`).join('')}</div></td>
    <td>${r.recommendation ? pill(r.recommendation) : '<span class="muted">analyzing...</span>'}${r.decision ? `<div><small class="muted">${r.decision.agreed ? 'approved' : 'overridden'}: ${esc(r.decision.outcome)}</small></div>` : ''}</td>
    <td>${r.risk ? riskPill(r.risk) : '-'}</td><td>${eff(r)}</td><td title="${when(r.created_at)}">${r.decision ? '<span class="muted">done</span>' : ago(r.created_at)}${r.processing_ms ? `<div><small class="muted">AI ${(r.processing_ms / 1000).toFixed(1)}s</small></div>` : ''}</td></tr>`).join('')}</table>`;
}
async function dashboardView() {
  const load = async () => { const [st, l] = await Promise.all([api('/stats'), api('/submissions')]); list = l; return st; };
  let st = await load();
  app.innerHTML = `${list.length ? '' : `<section class="hero"><h1>From messy broker documents to a decision-ready file in seconds.</h1>
      <p>SubmissionIQ reads emails, ACORD forms, schedules of values, loss runs and scans, scores property risk, screens valuation and flood exposure, and ranks your queue. Rules decide, AI explains, the underwriter approves.</p>
      <button class="btn light" id="demo">${ic('bolt')} Run demo with 4 sample submissions</button> <a class="btn ghost" href="#/new">Browse 15 real-world scenarios</a>
      <div class="flow"><span>Read</span><i>&rarr;</i><span>Validate</span><i>&rarr;</i><span>Locate</span><i>&rarr;</i><span>Value</span><i>&rarr;</i><span>Score risk</span><i>&rarr;</i><span>Apply guidelines</span><i>&rarr;</i><span>Explain</span><i>&rarr;</i><span>Underwriter decides</span></div></section>`}
    <div class="head gap"><div><h1>Underwriting work queue</h1><span class="muted">Ranked by urgency, risk, missing information and review status.</span></div>
      <div class="actions">${list.length ? `<button class="btn" id="demo">${ic('bolt')} Add 4 samples</button>` : ''}<a class="btn primary" href="#/new">${ic('plus')} New submission</a></div></div>
    <div class="stats six" id="stats">${statsHTML(st)}</div>
    <div class="grid2"><section class="card"><h2>AI recommendations</h2><div id="donut">${donut(st.byRecommendation)}</div></section>
      <section class="card"><h2>Property risk bands</h2><div id="bands">${Object.entries(st.byRisk).map(([k, v]) => `<div class="head" style="margin:6px 0"><span class="pill rb-${cls(k)}">${k}</span><b>${v}</b></div>`).join('')}</div></section></div>
    <section class="card"><div class="filters">${FILTERS.map((f) => `<button class="fchip ${qs.f === f ? 'on' : ''}" data-f="${f}">${f}</button>`).join('')}
      <input class="searchbox" id="q" type="text" placeholder="Search insured..." value="${esc(qs.q)}"></div><div id="tbl">${tableHTML()}</div></section>`;
  const d = $('#demo'); if (d) d.onclick = () => runDemo(d);
  document.querySelectorAll('.fchip').forEach((b) => (b.onclick = () => { qs.f = b.dataset.f; document.querySelectorAll('.fchip').forEach((x) => x.classList.toggle('on', x === b)); $('#tbl').innerHTML = tableHTML(); }));
  $('#q').oninput = (e) => { qs.q = e.target.value.trim().toLowerCase(); $('#tbl').innerHTML = tableHTML(); };
  const poll = async () => {
    if ((location.hash || '#/') !== '#/') return;
    if (list.some((r) => r.status === 'Processing')) {
      st = await load(); $('#stats').innerHTML = statsHTML(st); $('#donut').innerHTML = donut(st.byRecommendation); $('#tbl').innerHTML = tableHTML();
      $('#bands').innerHTML = Object.entries(st.byRisk).map(([k, v]) => `<div class="head" style="margin:6px 0"><span class="pill rb-${cls(k)}">${k}</span><b>${v}</b></div>`).join(''); timer = setTimeout(poll, 1200);
    }
  };
  poll();
}

// ---------- New submission ----------
async function newView() {
  const [samples, status] = await Promise.all([api('/samples'), api('/llm/status')]);
  let files = [], sampleId = null;
  app.innerHTML = `<h1>New submission</h1><p class="muted gap">Add one or many documents: broker email, ACORD form, schedule of values, loss runs, PDFs or scans. Or start from a real-world scenario.</p>
  <div class="grid2"><section class="card"><div class="drop" id="drop"><textarea id="txt" rows="12" placeholder="Paste a broker email or form text here (optional), or drop files onto this box..."></textarea></div>
    <div class="row"><label class="file"><input type="file" id="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx,.xls,.txt,.eml"><span>${ic('file')} Add files (PDF, image, CSV, Excel, text)</span></label>
    <button class="btn primary" id="go">Analyze submission ${ic('arrow')}</button></div><div id="flist"></div><div class="error" id="err"></div>
    <p class="hint" style="margin-top:14px">${status.ocr ? `<span class="statusok">&#10003; AI document reading is on</span>: scans, images and messy PDFs are read with OCR.` : '<span class="statusbad">AI document reading is off.</span> Text PDFs, CSV, Excel and text files work. Scans and images need GEMINI_API_KEY in your .env file.'}
    Location hazard lookup is ${status.hazardLookup ? 'on (FEMA flood data)' : 'off'}.</p></section>
    <section class="card"><h3>Real-world scenarios</h3><p class="muted" style="margin-top:0">Synthetic submissions modelled on common underwriting problems.</p>
    <div class="gallery">${samples.map((s) => `<button class="scard" data-id="${esc(s.id)}"><em>${esc(s.scenario)}${s.files.length > 1 ? ` · ${s.files.length} files` : ''}</em><b>${esc(s.title)}</b><small>${esc(s.challenge)}</small></button>`).join('')}</div></section></div>`;
  const renderFiles = () => { $('#flist').innerHTML = (sampleId ? `<div class="fileitem"><span>${ic('file')} Sample: <b>${esc(samples.find((s) => s.id === sampleId).title)}</b> (${samples.find((s) => s.id === sampleId).files.length} file${samples.find((s) => s.id === sampleId).files.length === 1 ? '' : 's'})</span><button data-x="sample">${ic('x')}</button></div>` : '')
    + files.map((f, i) => `<div class="fileitem"><span>${ic('file')} ${esc(f.name)} <small class="muted">${Math.round(f.size / 1024)} KB</small></span><button data-x="${i}">${ic('x')}</button></div>`).join(''); };
  $('#flist').onclick = (e) => { const b = e.target.closest('button[data-x]'); if (!b) return; if (b.dataset.x === 'sample') sampleId = null; else files.splice(+b.dataset.x, 1); renderFiles(); };
  const addFiles = (fl) => { files.push(...fl); renderFiles(); };
  let sampleName = null;
  document.querySelectorAll('.scard').forEach((b) => (b.onclick = async () => {
    const s = samples.find((x) => x.id === b.dataset.id); const d = await api('/samples/' + encodeURIComponent(s.id)); files = [];
    if (d.text) { sampleId = null; $('#txt').value = d.text; sampleName = s.title; } else { sampleId = s.id; $('#txt').value = ''; sampleName = null; }
    document.querySelectorAll('.scard').forEach((x) => x.classList.toggle('on', x === b)); renderFiles(); toast(`Loaded: ${s.title}`); window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  $('#file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { addFiles([...e.dataTransfer.files]); toast(`${e.dataTransfer.files.length} file(s) added`); });
  $('#go').onclick = async () => {
    const fd = new FormData(), t = $('#txt');
    if (sampleId) fd.append('sample', sampleId);
    else if (t.value.trim()) { fd.append('text', t.value); if (sampleName) fd.append('name', sampleName); }
    for (const f of files) fd.append('files', f);
    $('#go').disabled = true; $('#err').textContent = '';
    try { location.hash = '#/s/' + (await api('/submissions', { method: 'POST', body: fd })).id; }
    catch (e) { $('#err').textContent = e.message; $('#go').disabled = false; }
  };
}

// ---------- Submission detail ----------
const AGENTS = ['Document agent', 'Validation agent', 'Location agent', 'Valuation agent', 'Risk scoring agent', 'Appetite agent', 'Risk summary agent', 'Broker communication agent'];
async function detailView(id) {
  guidelines = guidelines || (await api('/guidelines'));
  const tick = async () => {
    try { const s = await api('/submissions/' + id); paint(s); if (s.status !== 'Processing') clearInterval(timer); }
    catch (e) { clearInterval(timer); app.innerHTML = `<div class="card error">${esc(e.message)}</div>`; }
  };
  await tick(); timer = setInterval(tick, 600);
}
async function decide(s, outcome, note, uw) {
  store('siq-uw', uw);
  await api(`/submissions/${s.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome, note, underwriter: uw }) });
  toast('Decision recorded'); paint(await api('/submissions/' + s.id));
}
const factorHTML = (f) => `<div class="factor"><div><b>${esc(f.label)}</b>${f.assumed ? '<span class="tag warn">assumed</span>' : ''}${f.unassessed ? '<span class="tag">not assessed</span>' : ''}</div>
  <div><div class="fbar"><i class="${f.level}" style="width:${f.unassessed ? 4 : Math.max(4, (f.points / f.max) * 100)}%"></i></div><small>${esc(f.reason)}</small>
  <div class="reasons">${(f.evidence || []).filter((e) => e.value !== null && e.value !== undefined && e.source && e.source.docId).slice(0, 2).map((e) => srcChip({ ...e.source, field: e.field, quote: '' })).join('')}</div></div>
  <div class="fpts">${f.unassessed ? '-' : f.points}<small>of ${f.max}</small></div></div>`;
function riskCard(s) {
  const r = s.risk, bandColor = { Low: 'ok', Moderate: 'info', Elevated: 'warn', High: 'bad' }[r.band] || 'mute';
  const loc = r.locations && r.locations.length > 1 ? `<h3 style="margin-top:18px">Locations (${r.locations.length})</h3><table class="mini"><tr><th>Loc</th><th>Name</th><th>TIV</th><th>Risk</th><th>Valuation</th></tr>${r.locations.map((l) => {
    const v = s.valuation?.byLocation?.[l.loc_no]; return `<tr><td>${esc(l.loc_no)}</td><td>${esc(l.name || l.address || '')}</td><td>${usd(l.tiv)}</td><td>${riskPill(l)}</td><td>${v ? `<span class="pill ${v.status === 'undervalued' || v.status === 'unusually_high' ? 'refer' : 'quote'}">${esc(v.status.replace('_', ' '))}</span>` : '-'}</td></tr>`; }).join('')}</table><p class="disc">Account score: ${esc(r.method)}. Worst location: ${esc(r.worst?.name || r.worst?.loc_no)} (${r.worst?.score}).</p>` : '';
  return `<section class="card"><h2>Property risk score <small class="muted">model v${esc(r.modelVersion)}</small></h2>
    <div class="riskhead"><div><div class="bigscore" style="color:var(--${bandColor})">${r.score ?? '-'}</div><span class="pill rb-${cls(r.band)}">${esc(r.band)} risk</span></div>
    <div style="flex:1;min-width:240px"><div class="scale">${r.score !== null ? `<i style="left:${r.score}%"></i>` : ''}</div><div class="head" style="font-size:11px;color:var(--mute);margin-top:6px"><span>Low</span><span>Moderate</span><span>Elevated</span><span>High</span></div>
    <p class="hint" style="margin:8px 0 0">${r.drivers.length ? '<b>Top drivers:</b> ' + r.drivers.map((d) => esc(d.label)).join(' · ') : 'No single dominant driver.'} · Based on ${r.assessed} of ${r.total} factors${r.assumed.length ? `; ${r.assumed.length} assumed because data is missing` : ''}. Higher means riskier. This is separate from submission completeness.</p></div></div>
    ${r.factors.map(factorHTML).join('')}${loc}</section>`;
}
function traceCard(s) {
  const order = { decline: 0, refer: 1, unknown: 2, pass: 3 };
  const items = [...s.trace].sort((a, b) => order[a.status] - order[b.status]);
  return `<section class="card"><h2>Why this recommendation <small class="muted">guidelines v${esc(s.appetite.guidelines)}</small></h2>
    <p class="muted" style="margin-top:0">${pill(s.recommendation)} The recommendation comes only from these rules. Each shows the rule, the extracted evidence it used and where that evidence came from.</p>
    ${items.map((c) => `<div class="trace ${c.status === 'decline' ? 'bad' : c.status === 'refer' ? 'fail' : ''}"><div class="head"><span><span class="st st-${c.status}" style="padding:2px 9px;border-radius:7px;font-size:10.5px;font-weight:800;text-transform:uppercase">${c.status}</span> <b>${esc(c.name)}</b> <small class="muted">${esc(c.ref)}</small></span></div>
      <div class="rule"><b>Rule:</b> ${esc(c.rule)}</div><div>${esc(c.detail)}</div>
      <div class="inps" style="margin-top:8px">${c.inputValues.map((i) => `<span class="inp"><b>${esc(FL[i.field] || i.field)}</b> ${i.field === 'loss_history' ? esc(i.value === null ? 'missing' : (i.value.length + ' loss' + (i.value.length === 1 ? '' : 'es'))) : (fmt(i.field, i.value) === null ? '<span class="miss">missing</span>' : esc(fmt(i.field, i.value)))} ${srcChip(i.evidence && { ...i.evidence, field: i.field })}</span>`).join('')}</div></div>`).join('')}</section>`;
}
function fieldsCard(s, editable) {
  const ex = s.extracted, ev = s.evidence, conf = s.meta.list || [];
  return `<section class="card"><h2>Extracted data <small class="muted">click a source to see the page</small></h2>
    ${conf.map((c) => `<div class="conflict">${ic('alert')} ${esc(c.note ? 'Schedule of values total does not match its rows' : (FL[c.field] || c.field) + ' differs between documents')}: using ${esc(cv(c.chosen.value))} (${esc(c.chosen.doc)}, p.${c.chosen.page}); also ${c.others.map((o) => `${esc(cv(o.value))} (${esc(o.doc || '?')}, p.${o.page ?? '?'})`).join('; ')}</div>`).join('')}
    ${ROWS.map((f) => { const v = fmt(f, ex[f]), e = ev[f]; return `<div class="frow" data-f="${f}"><span class="fl">${FL[f]}</span><span class="fv">${v === null ? '<span class="miss">missing</span>' : esc(v)}</span>
      <span class="fm">${confDot(e)} ${srcChip(e && { ...e, field: f })}</span>${editable ? `<button class="edit" data-edit="${f}" title="${v === null ? 'Add value' : 'Correct value'}">${ic('pencil')}</button>` : '<span></span>'}</div>`; }).join('')}
    <div class="frow"><span class="fl">Loss history</span><span class="fv">${ex.loss_history === null ? '<span class="miss">not provided</span>' : ex.loss_history.length + ' loss' + (ex.loss_history.length === 1 ? '' : 'es')}</span><span class="fm">${confDot(ev.loss_history)} ${srcChip(ev.loss_history && { ...ev.loss_history, field: 'loss_history' })}</span><span></span></div>
    <p class="hint" style="margin-bottom:0"><span class="conf hi"></span>high <span class="conf md"></span>medium <span class="conf lo"></span>low confidence <span class="conf us"></span>corrected by reviewer. Corrections re-run all checks and are logged.</p></section>`;
}
function valuationCard(s) {
  const v = s.valuation; if (!v) return '';
  const first = v.byLocation ? null : v;
  let viz = '';
  if (first && first.low) {
    const lo = Math.min(first.declared, first.low) * 0.55, hi = Math.max(first.declared, first.high) * 1.15, pos = (x) => ((x - lo) / (hi - lo)) * 100;
    viz = `<div class="range"><div class="band" style="left:${pos(first.low)}%;width:${pos(first.high) - pos(first.low)}%"></div><div class="mk" style="left:${pos(first.declared)}%"><small>Declared</small></div></div>
      <div class="head" style="font-size:12.5px"><span>Screening range <b>${usd(first.low)} to ${usd(first.high)}</b> (${first.basis.occupancy_psf[0]}-${first.basis.occupancy_psf[1]} $/sq ft × construction ${first.basis.construction_factor} × region ${first.basis.region_factor})</span><span>Declared <b>${usd(first.declared)}</b> · ${first.psf} $/sq ft · ${first.itv_pct}% of mid estimate</span></div>`;
  } else if (v.byLocation) viz = `<table class="mini"><tr><th>Loc</th><th>Declared</th><th>Screening range</th><th>Status</th></tr>${Object.entries(v.byLocation).map(([k, l]) => `<tr><td>${esc(l.name || k)}</td><td>${usd(l.declared)}</td><td>${l.low ? usd(l.low) + ' to ' + usd(l.high) : '-'}</td><td><span class="pill ${['undervalued', 'unusually_high'].includes(l.status) ? 'refer' : 'quote'}">${esc(l.status.replace('_', ' '))}</span></td></tr>`).join('')}</table>`;
  return `<section class="card"><h2>Insured value screening <span class="pill ${['undervalued', 'unusually_high'].includes(v.status) ? 'refer' : v.status === 'not_assessed' ? 'rb-unknown' : 'quote'}">${esc(v.status.replace('_', ' '))}</span></h2><p>${esc(v.summary)}</p>${viz}
    <p class="disc">${esc(v.disclaimer || 'Screening estimate, not a certified valuation.')} Benchmarks are illustrative defaults (data/valuation.json); replace them with your valuation source.</p></section>`;
}
function hazardCard(s) {
  const h = s.hazards?.main; if (!h) return '';
  const f = h.flood;
  const flood = h.status === 'ok' && f ? `<dl class="hzrow"><dt>Flood zone</dt><dd><b>${esc(f.zone || 'Not mapped')}</b> ${f.level ? `<span class="pill ${f.level === 'high' ? 'decline' : f.level === 'moderate' ? 'refer' : 'quote'}">${esc(f.level)}</span>` : ''}<br>${esc(f.description)}</dd>
      <dt>Evidence</dt><dd>Address matched as <i>${esc(h.geocode.matched)}</i> (${h.geocode.lat.toFixed(4)}, ${h.geocode.lon.toFixed(4)}) via ${esc(h.geocode.source)}.</dd>
      <dt>Source</dt><dd>${esc(f.source)}</dd><dt>Retrieved</dt><dd>${esc(f.retrieved)}${h.cached ? ' (cached)' : ''}</dd><dt>Source updated</dt><dd>${f.sourceUpdated ? esc(f.sourceUpdated) : 'Not published by the service'}</dd></dl>`
    : `<div class="flag">${ic('alert')} Flood hazard not assessed: ${esc(h.status === 'disabled' ? 'location lookup is switched off.' : h.error || h.status)}</div>`;
  return `<section class="card"><h2>${ic('pin')} Location hazards</h2>${flood}
    <dl class="hzrow"><dt>Fire service</dt><dd><span class="tag">not assessed</span> ${esc(h.fire_service.note)}${s.extracted.protection_class ? ` Declared protection class: <b>${s.extracted.protection_class}</b>.` : ''}</dd><dt>Wildfire</dt><dd><span class="tag">not assessed</span> ${esc(h.wildfire.note)}</dd></dl>
    <p class="disc">One verified source is used on purpose. Hazards without a configured, reliable source are shown as not assessed rather than guessed.</p></section>`;
}
function decisionCard(s) {
  const d = s.decision;
  if (!d) return `<p class="muted">AI recommends: ${pill(s.recommendation)} You make the final call.</p>
    <div class="grid2" style="margin:0"><div><select id="outcome">${['Quote', 'Refer', 'Decline', 'Need Info'].map((o) => `<option ${o === s.recommendation ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <p class="muted" id="hint"></p><input type="text" id="uw" placeholder="Your name" value="${esc(store('siq-uw') || '')}"></div><textarea id="note" rows="4" placeholder="Notes / reason (required if you override)"></textarea></div>
    <div class="row"><span class="error" id="derr"></span><button class="btn primary" id="submit">Confirm decision</button></div>`;
  return `<dl class="hzrow"><dt>Decision</dt><dd>${pill(d.outcome)} ${d.agreed ? 'Approved the AI recommendation' : `<b>Overrode</b> the AI recommendation (${esc(d.ai_recommendation)})`}</dd><dt>Reviewer</dt><dd>${esc(d.underwriter)}</dd><dt>Approved at</dt><dd>${when(d.ts)} (${d.minutes_to_decision} min after receipt)</dd>
    <dt>Guideline version</dt><dd>v${esc(d.guideline_version)}</dd><dt>AI risk score</dt><dd>${d.risk_score ?? '-'} (${esc(d.risk_band || 'n/a')})</dd>${d.note ? `<dt>${d.agreed ? 'Note' : 'Override reason'}</dt><dd>&ldquo;${esc(d.note)}&rdquo;</dd>` : ''}</dl>
    <div class="row"><span class="hint">The decision, evidence, rules and audit trail are exported as one record.</span><a class="btn" href="/api/submissions/${s.id}/record">${ic('download')} Export decision record (JSON)</a></div>`;
}
function paint(s) {
  SRC = [];
  if (s.status === 'Processing') {
    const nDone = s.audit.filter((a) => a.status === 'done' && AGENTS.includes(a.agent)).length;
    return (app.innerHTML = `<a class="back" href="#/">&larr; Queue</a><div class="card"><h2>Agents at work on submission #${s.id}</h2>
      <div class="bar gap"><i style="width:${Math.min(100, (nDone / AGENTS.length) * 100)}%"></i></div>
      <ul class="steps">${AGENTS.map((a) => { const r = [...s.audit].reverse().find((x) => x.agent === a);
        return `<li><span class="dot ${r ? r.status : ''}">${r ? (r.status === 'done' ? '&#10003;' : r.status === 'error' ? '!' : '') : ''}</span><div><b>${a}</b><br><small class="muted">${r ? esc(r.detail || 'Working...') : 'Waiting'}</small></div></li>`; }).join('')}</ul></div>`);
  }
  if (s.status === 'Error') return (app.innerHTML = `<a class="back" href="#/">&larr; Queue</a><div class="card error">Processing failed. See the server log.<div style="margin-top:10px"><button class="btn" id="retry">Try again</button></div></div>`, $('#retry').onclick = async () => { await api(`/submissions/${s.id}/rerun`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); detailView(s.id); });
  const ex = s.extracted, v = s.validation, sm = s.summary, rec = s.recommendation, g = guidelines, risk = s.risk, locked = !!s.decision;
  document.title = `Underwriting file - ${ex.insured_name || s.source_name}`;
  const tiv = (ex.tiv_building || 0) + (ex.tiv_contents || 0) + (ex.tiv_bi || 0), losses = ex.loss_history, maxLoss = Math.max(1, ...(losses || []).map((l) => l.paid));
  const seg = (n, c) => (tiv && n ? `<i style="width:${(n / tiv) * 100}%;background:${c}"></i>` : '');
  const fails = s.appetite.checks.filter((c) => c.status === 'refer' || c.status === 'decline').length, ok = s.appetite.checks.filter((c) => c.status === 'pass').length;
  const mode = /gemini|anthropic/.test(s.provider || '') ? 'AI-assisted' : 'Rules engine';
  const bandCol = { Low: '#17a673', Moderate: '#4a8bf5', Elevated: '#e09a21', High: '#e5543f' }[risk?.band] || '#999';
  app.innerHTML = `<div class="head"><a class="back" href="#/">&larr; Queue</a><div class="actions"><button class="btn" id="print">${ic('printer')} Print / save as PDF</button></div></div>
  <div class="card banner ${cls(rec)}"><div class="head" style="justify-content:flex-start"><div class="bigicon">${ICON[rec]}</div>
    <div><small>AI RECOMMENDATION</small><h1>${esc(rec)}</h1><div class="sub">${esc(ex.insured_name || s.source_name)} &middot; ${esc(ex.class_of_business || 'class unknown')}${ex.state ? ' &middot; ' + esc(ex.state) : ''}</div></div></div>
    <div class="ringwrap"><div class="ring" style="--p:${risk.score ?? 0}"><span>${risk.score ?? '-'}</span></div>PROPERTY RISK · ${esc((risk.band || '').toUpperCase())}</div></div>
  <div class="chips"><span class="chip">${priPill(s.priority)}</span><span class="chip"><b>${ok}</b> <em>checks passed</em></span><span class="chip"><b style="color:var(--warn)">${fails}</b> <em>${fails === 1 ? 'flag' : 'flags'}</em></span>
    <span class="chip"><b style="color:var(--info)">${v.completeness}%</b> <em>complete</em></span><span class="chip">${ic('clock')} <b>${(s.processing_ms / 1000).toFixed(1)}s</b> <em>processing</em></span>
    <span class="chip"><em>${mode} &middot; #${s.id} &middot; ${when(s.created_at)}</em></span></div>
  ${s.priority.needsAttention ? `<div class="card" style="padding:14px 18px"><b>Why it needs attention:</b> <span class="reasons" style="display:inline-flex">${s.priority.reasons.map((x) => `<span>${esc(x)}</span>`).join('')}</span></div>` : ''}

  <div class="card"><h2>${esc(sm.headline)}</h2><p>${esc(sm.summary)}</p>
    <div class="grid2" style="gap:26px;margin:0"><div><h3>Strengths</h3>${sm.strengths?.length ? `<ul class="tight">${sm.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="muted">None noted</span>'}</div>
    <div><h3>Concerns</h3>${sm.concerns?.length ? `<ul class="tight">${sm.concerns.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="muted">None noted</span>'}</div></div></div>

  <section class="card"><h2>Source documents (${s.documents.length})</h2><div class="doclist">${s.documents.map((d) => `<button class="doc" data-doc="${d.id}">${ic('file')}<span><b>${esc(d.name)}</b><br><small>${esc(d.kind)} · ${d.pages} page${d.pages === 1 ? '' : 's'}${d.scanned ? ' · scanned' : ''}</small></span></button>`).join('')}</div>
    ${s.meta.unread?.length ? `<div class="flag" style="margin-top:12px">${ic('alert')} ${s.meta.unread.map((u) => esc(u.name)).join(', ')}: scanned or image document(s) could not be read. Set GEMINI_API_KEY to enable OCR, then re-run.</div>` : ''}</section>

  ${riskCard(s)}
  <div class="grid2">${valuationCard(s)}${hazardCard(s)}</div>
  ${traceCard(s)}
  ${fieldsCard(s, !locked)}
  <div class="grid2"><section class="card"><h2>Loss history</h2>${losses === null ? '<p class="miss">Not provided</p>' : losses.length ?
      losses.map((l) => `<div class="lossrow"><b>${esc(l.year)}</b><div><div class="bar ${l.paid >= g.losses.refer_single_loss ? 'big' : ''}"><i style="width:${Math.max(4, (l.paid / maxLoss) * 100)}%"></i></div><small class="muted">${esc(l.cause)}${l.status ? ' &middot; ' + esc(l.status) : ''}</small> ${l.source ? srcChip({ ...l.source, field: 'loss_history' }) : ''}</div><b>${usd(l.paid)}</b></div>`).join('') : '<p>No losses reported.</p>'}
      <h2 style="margin-top:22px">Total insured value ${tiv ? usd(tiv) : ''}</h2>${tiv ? `<div class="seg">${seg(ex.tiv_building, 'var(--a)')}${seg(ex.tiv_contents, 'var(--b)')}${seg(ex.tiv_bi, '#c084fc')}</div>
      <div class="segleg"><span>Building <b>${usd(ex.tiv_building) || '-'}</b></span><span>Contents <b>${usd(ex.tiv_contents) || '-'}</b></span><span>BI <b>${usd(ex.tiv_bi) || '-'}</b></span></div>
      <div class="gauge"><div class="bar"><i style="width:${Math.min(100, (tiv / g.limits.max_tiv) * 100)}%;background:${tiv > g.limits.max_tiv ? 'var(--bad)' : tiv > g.limits.uw_authority_tiv ? 'var(--warn)' : 'var(--ok)'}"></i></div>
      <div class="mark" style="left:${(g.limits.uw_authority_tiv / g.limits.max_tiv) * 100}%"><small>UW authority ${usd(g.limits.uw_authority_tiv / 1e6)}M</small></div></div><small class="muted">Scale: 0 to ${usd(g.limits.max_tiv / 1e6)}M maximum capacity</small>` : '<p class="miss">Building value missing.</p>'}</section>
    <section class="card"><h2>Completeness: ${v.completeness}%</h2><div class="bar gap"><i style="width:${v.completeness}%"></i></div>
    ${v.missing.length ? `<h3>Missing</h3><ul class="tight">${v.missing.map((m) => `<li class="${m.critical ? 'miss' : ''}">${esc(m.label)}${m.critical ? ' (critical)' : ''}</li>`).join('')}</ul>` : '<p class="muted">All expected fields present.</p>'}
    ${v.flags.map((x) => `<div class="flag">${esc(x.text)}</div>`).join('')}</section></div>
  <section class="card"><h2>Broker email draft</h2><textarea id="mail" rows="10">${esc(s.broker_email)}</textarea>
    <div class="row"><span class="muted">Edit before sending.</span><button class="btn" id="copy">${ic('file')} Copy</button></div></section>

  <section class="card" id="decide"><h2>${s.decision ? 'Decision record' : 'Underwriter decision'}</h2>${decisionCard(s)}</section>
  <section class="card"><h2>Audit trail</h2><table class="audit"><tr><th>Time</th><th>Actor</th><th>Detail</th><th>ms</th></tr>
    ${s.audit.map((a) => `<tr><td>${new Date(a.ts).toLocaleTimeString()}</td><td><b>${esc(a.agent)}</b></td><td>${esc(a.detail)}</td><td>${a.duration_ms ?? ''}</td></tr>`).join('')}</table></section>
  ${s.decision ? '' : `<div class="stick"><span>AI recommends ${pill(rec)}</span><button class="btn" id="override">Override...</button><button class="btn primary" id="approve">${ic('check')} Approve recommendation</button></div>`}`;
  $('#print').onclick = () => window.print();
  $('#copy').onclick = () => { navigator.clipboard.writeText($('#mail').value); toast('Email copied'); };
  document.querySelectorAll('.doc').forEach((b) => (b.onclick = () => openSource({ docId: +b.dataset.doc, page: 1, quote: '' }).catch((e) => toast(e.message))));
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editField(s, b.dataset.edit)));
  if (!s.decision) {
    const sel = $('#outcome'), hint = $('#hint');
    const sync = () => (hint.textContent = sel.value === rec ? 'Matches the AI recommendation.' : 'You are overriding the AI - a reason is required.');
    sel.onchange = sync; sync();
    $('#submit').onclick = async () => { $('#submit').disabled = true; $('#derr').textContent = ''; try { await decide(s, sel.value, $('#note').value, $('#uw').value || 'Underwriter'); } catch (e) { $('#derr').textContent = e.message; $('#submit').disabled = false; } };
    $('#approve').onclick = async () => { $('#approve').disabled = true; try { await decide(s, rec, '', store('siq-uw') || 'Underwriter'); } catch (e) { toast(e.message); $('#approve').disabled = false; } };
    $('#override').onclick = () => { $('#decide').scrollIntoView({ behavior: 'smooth', block: 'center' }); sel.focus(); };
  }
}
function editField(s, f) {
  const row = $(`.frow[data-f="${f}"]`), cur = s.extracted[f];
  const input = f === 'sprinklered' ? `<select id="ev"><option value="">(clear)</option><option ${cur === true ? 'selected' : ''}>Yes</option><option ${cur === false ? 'selected' : ''}>No</option></select>` : `<input type="text" id="ev" value="${esc(cur ?? '')}" placeholder="${f === 'effective_date' ? 'YYYY-MM-DD' : ''}">`;
  row.innerHTML = `<span class="fl">${FL[f]}</span><span class="fv">${input}<input type="text" id="er" placeholder="Reason / source of correction (optional)" style="margin-top:6px"></span><span class="fm"></span>
    <span style="display:flex;gap:4px"><button class="edit" id="esave" title="Save" style="color:var(--ok)">${ic('check')}</button><button class="edit" id="ecancel" title="Cancel">${ic('x')}</button></span>`;
  $('#ev').focus();
  $('#ecancel').onclick = () => paint(s);
  const save = async () => {
    try {
      await api(`/submissions/${s.id}/fields`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field: f, value: $('#ev').value, reviewer: store('siq-uw') || 'Underwriter', reason: $('#er').value }) });
      toast('Saved. Re-running checks...'); detailView(s.id);
    } catch (e) { toast(e.message); }
  };
  $('#esave').onclick = save; $('#ev').onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

// ---------- Guidelines & AI ----------
async function guidelinesView() {
  const [c, st] = await Promise.all([api('/config'), api('/llm/status')]); const g = (guidelines = c.guidelines), m = c.risk_model;
  const codes = (a) => a.map((x) => `<code>${esc(x.trim())}</code>`).join(' ');
  app.innerHTML = `<h1>Guidelines &amp; AI</h1><p class="muted gap">${esc(g.carrier)} &middot; v${esc(g.version)}. </p>
  <section class="card"><h2>AI connection</h2><dl class="hzrow"><dt>Provider</dt><dd>${st.configured ? `<span class="statusok">Connected key found</span> ` : '<span class="statusbad">No API key</span>: running on the rules engine only'}</dd>
    <dt>Scan / image OCR</dt><dd>${st.ocr ? 'Available (AI reads scans and images)' : 'Needs GEMINI_API_KEY'}</dd><dt>Location lookup</dt><dd>${st.hazardLookup ? 'On (US Census geocoder + FEMA flood data)' : 'Off'}</dd></dl>
    <div class="row"><span class="hint" id="tres">Sends one tiny request to check your key, model and quota.</span><button class="btn primary" id="ttest">${ic('bolt')} Test AI connection</button></div></section>
  <div class="grid2"><section class="card"><h2>Class of business</h2><h3>Preferred</h3><p>${codes(g.classes.preferred)}</p><h3>Referral</h3><p>${codes(g.classes.referral)}</p><h3>Prohibited</h3><p>${codes(g.classes.prohibited)}</p><h3>Admitted states</h3><p>${codes(g.states_admitted)}</p></section>
  <section class="card"><h2>Limits &amp; thresholds</h2><dl class="kv"><dt>UW authority (TIV)</dt><dd>${usd(g.limits.uw_authority_tiv)}</dd><dt>Max capacity (TIV)</dt><dd>${usd(g.limits.max_tiv)}</dd>
  <dt>Sprinklers above</dt><dd>${usd(g.limits.sprinkler_required_above_tiv)}</dd><dt>Frame max stories</dt><dd>${g.construction.frame_max_stories}</dd><dt>Refer if built before</dt><dd>${g.building_age.refer_before_year}</dd>
  <dt>Loss window</dt><dd>${g.losses.years} years</dd><dt>Refer at # losses</dt><dd>${g.losses.refer_count}+</dd><dt>Refer single loss</dt><dd>${usd(g.losses.refer_single_loss)}+</dd><dt>Decline total paid</dt><dd>${usd(g.losses.decline_total_paid)}+</dd>
  <dt>Min years in business</dt><dd>${g.experience.min_years_in_business}</dd><dt>Refer protection class</dt><dd>${g.protection_class.refer_at_or_above}+</dd><dt>Valuation</dt><dd>refer if undervalued or unusually high</dd><dt>Flood</dt><dd>refer in FEMA Special Flood Hazard Area</dd></dl></section></div>
  <section class="card"><h2>Property risk model <small class="muted">v${esc(m.version)}</small></h2><p class="muted" style="margin-top:0">${esc(m.note)}</p>
    <table class="mini"><tr><th>Factor</th><th>Max points</th><th>What drives it</th></tr>
    <tr><td>Construction</td><td>${m.factors.construction.max}</td><td>Fire resistive lowest, frame highest</td></tr><tr><td>Building age</td><td>${m.factors.age.max}</td><td>Older buildings score higher</td></tr>
    <tr><td>Fire protection</td><td>${m.factors.protection.max}</td><td>Sprinklers and ISO protection class</td></tr><tr><td>Occupancy hazard</td><td>${m.factors.occupancy.max}</td><td>Restaurants, manufacturing and vacancy score higher than offices</td></tr>
    <tr><td>Loss history</td><td>${m.factors.losses.max}</td><td>Frequency, severity, fire/electrical causes, open claims</td></tr><tr><td>Exposure size</td><td>${m.factors.exposure.max}</td><td>Total insured value</td></tr>
    <tr><td>Location (flood)</td><td>${m.factors.location.max}</td><td>FEMA flood zone. Left out of the score when not assessed</td></tr><tr><td>Insured value adequacy</td><td>${m.factors.valuation.max}</td><td>Declared vs screening replacement cost. Left out when not assessed</td></tr></table>
    <p class="disc">Bands: ${m.bands.map((b) => `${b.name} up to ${b.max}`).join(' · ')}. Valuation benchmarks: ${esc(c.valuation.note)}</p></section>`;
  $('#ttest').onclick = async () => {
    $('#ttest').disabled = true; $('#tres').textContent = 'Testing...';
    try { const r = await api('/llm/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      $('#tres').innerHTML = r.ok ? `<span class="statusok">&#10003; Working.</span> AI replied in ${r.latencyMs} ms.` : `<span class="statusbad">Not working:</span> ${esc(r.error)}`; }
    catch (e) { $('#tres').innerHTML = `<span class="statusbad">${esc(e.message)}</span>`; }
    $('#ttest').disabled = false;
  };
}

// ---------- Quick actions (Ctrl/Cmd+K) ----------
const CMDS = [
  { t: 'Go to work queue', i: 'home', k: 'queue dashboard home', f: () => (location.hash = '#/') },
  { t: 'New submission', i: 'plus', k: 'upload paste analyze scenarios', f: () => (location.hash = '#/new') },
  { t: 'Run demo with 4 sample submissions', i: 'bolt', k: 'demo samples', f: () => { location.hash = '#/'; setTimeout(() => $('#demo')?.click(), 700); } },
  { t: 'Guidelines, risk model and AI settings', i: 'sliders', k: 'appetite rules ai gemini settings', f: () => (location.hash = '#/guidelines') },
  { t: 'Test AI connection', i: 'shield', k: 'gemini key check status', f: () => { location.hash = '#/guidelines'; setTimeout(() => $('#ttest')?.click(), 900); } },
  { t: 'Toggle light / dark theme', i: 'moon', k: 'theme appearance', f: () => $('#theme').click() },
  { t: 'Open landing page', i: 'arrow', k: 'website', f: () => (location.href = '/') }
];
let pi = 0, shown = CMDS;
function palRender() {
  const q = $('#palq').value.toLowerCase(); shown = CMDS.filter((c) => (c.t + ' ' + c.k).toLowerCase().includes(q)); pi = Math.min(pi, Math.max(0, shown.length - 1));
  $('#pall').innerHTML = shown.map((c, i) => `<li class="${i === pi ? 'on' : ''}" data-i="${i}">${ic(c.i)}<span>${c.t}</span></li>`).join('') || '<li class="none">No matches</li>';
}
function palOpen(open) { $('#pal').hidden = !open; if (open) { $('#palq').value = ''; pi = 0; palRender(); $('#palq').focus(); } }
function palRun(i) { const c = shown[i]; palOpen(false); if (c) c.f(); }
$('#cmdk').onclick = () => palOpen(true);
$('#palq').oninput = () => { pi = 0; palRender(); };
$('#pall').onclick = (e) => { const li = e.target.closest('li[data-i]'); if (li) palRun(+li.dataset.i); };
$('#pal').onclick = (e) => { if (e.target.id === 'pal') palOpen(false); };
document.addEventListener('keydown', (e) => {
  const open = !$('#pal').hidden;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palOpen(!open); return; }
  if (!open) return;
  if (e.key === 'Escape') palOpen(false);
  else if (e.key === 'ArrowDown') { e.preventDefault(); pi = Math.min(shown.length - 1, pi + 1); palRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pi = Math.max(0, pi - 1); palRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(pi); }
});

route();
