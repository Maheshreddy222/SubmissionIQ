// Deterministic parsing of spreadsheets / CSVs: schedules of values (SOV) and loss runs.
const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$,\s]/g, '');
  if (/^\(.*\)$/.test(s)) return -parseFloat(s.slice(1, -1)) || 0;
  const m = s.match(/^-?\d+(\.\d+)?(m|k)?$/i);
  if (!m) return null;
  let n = parseFloat(s);
  if (/m$/i.test(s)) n *= 1e6; if (/k$/i.test(s)) n *= 1e3;
  return Math.round(n);
};
const yesNo = (v) => { const s = String(v ?? '').trim().toLowerCase(); if (!s) return null; if (/^(y|yes|true|1|full|partial|wet|dry|esfr|100%?)/.test(s)) return true; if (/^(n|no|false|0|none|unsprinklered)/.test(s)) return false; return null; };

function parseCSV(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', '\t', ';', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const SOV = {
  loc_no: ['loc', 'loc no', 'loc number', 'location no', 'location number', 'bldg no', 'bldg number', 'building no', 'building number', 'no', 'id', 'prem', 'prem no'],
  name: ['location name', 'property name', 'location', 'name', 'description', 'property'],
  address: ['address', 'street address', 'street', 'location address', 'premises address', 'premises'],
  city: ['city'], state: ['state', 'st'], zip: ['zip', 'zip code', 'postal code'],
  occupancy: ['occupancy', 'occupancy type', 'class', 'use', 'description of operations', 'operations', 'occupancy class'],
  construction: ['construction', 'construction type', 'const', 'const type', 'construction class'],
  year_built: ['year built', 'yr built', 'built', 'year of construction', 'yoc'],
  stories: ['stories', 'no of stories', 'number of stories', 'floors', 'of stories'],
  square_feet: ['sq ft', 'sqft', 'square feet', 'square footage', 'area', 'total area', 'sf', 'building area'],
  sprinklered: ['sprinklered', 'sprinkler', 'sprinklers', 'sprinkler y n', 'sprk', 'sprinkler system'],
  protection_class: ['protection class', 'ppc', 'iso ppc', 'fire protection class'],
  tiv_building: ['building value', 'building', 'bldg value', 'bldg', 'building limit', 'building amount', 'building tiv', 'real property'],
  tiv_contents: ['contents value', 'contents', 'bpp', 'business personal property', 'contents amount', 'stock', 'personal property'],
  tiv_bi: ['business income', 'bi', 'bi ee', 'rents', 'rental income', 'time element', 'business income amount', 'bi value'],
  tiv: ['tiv', 'total insured value', 'total value', 'total', 'total tiv']
};
const LOSS = {
  date: ['date of loss', 'loss date', 'dol', 'date', 'accident date', 'occurrence date'],
  year: ['year', 'policy year', 'loss year', 'pol year'],
  cause: ['cause of loss', 'cause', 'peril', 'loss type', 'type of loss', 'loss description', 'claim description', 'description'],
  paid: ['total paid', 'paid', 'paid amount', 'amount paid', 'gross paid', 'paid loss'],
  incurred: ['total incurred', 'incurred', 'gross incurred'],
  reserve: ['reserve', 'outstanding', 'os reserve', 'outstanding reserve', 'reserves'],
  status: ['status', 'claim status', 'open closed', 'open closed status'],
  claim_no: ['claim', 'claim no', 'claim number', 'claim']
};

function colMap(headers, dict) {
  const hs = headers.map(norm), used = new Set(), map = {};
  for (const [f, syns] of Object.entries(dict)) {
    let idx = hs.findIndex((h, i) => !used.has(i) && syns.includes(h));
    if (idx < 0) idx = hs.findIndex((h, i) => !used.has(i) && syns.some((s) => s.length >= 5 && (h.startsWith(s + ' ') || h.endsWith(' ' + s))));
    if (idx >= 0) { map[f] = idx; used.add(idx); }
  }
  return map;
}
function findHeader(rows, dict, minHits) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const m = colMap(rows[i], dict);
    if (Object.keys(m).length >= minHits) return { row: i, map: m };
  }
  return null;
}
function detectTable(rows) {
  const s = findHeader(rows, SOV, 4), l = findHeader(rows, LOSS, 3);
  const sc = s ? Object.keys(s.map).length : 0, lc = l ? Object.keys(l.map).length : 0;
  if (!sc && !lc) return null;
  const hasAmt = (m) => m.tiv_building !== undefined || m.tiv !== undefined;
  if (s && hasAmt(s.map) && sc >= lc) return 'sov';
  if (l && (l.map.paid !== undefined || l.map.incurred !== undefined)) return 'loss_run';
  return s && hasAmt(s.map) ? 'sov' : null;
}

function mapSOV(rows) {
  const h = findHeader(rows, SOV, 4); if (!h) return null;
  const locations = []; let declaredTotal = null;
  const get = (r, f) => (h.map[f] === undefined ? '' : String(r[h.map[f]] ?? '').trim());
  for (let i = h.row + 1; i < rows.length; i++) {
    const r = rows[i], first = String(r.find((x) => String(x).trim() !== '') ?? '').trim();
    if (/^(grand )?(sub)?total/i.test(first)) {
      const t = num(get(r, 'tiv')); const parts = ['tiv_building', 'tiv_contents', 'tiv_bi'].map((f) => num(get(r, f)) || 0);
      declaredTotal = t ?? (parts.reduce((a, b) => a + b, 0) || null); continue;
    }
    const b = num(get(r, 'tiv_building')), c = num(get(r, 'tiv_contents')), bi = num(get(r, 'tiv_bi')), t = num(get(r, 'tiv'));
    if (b === null && c === null && bi === null && t === null) continue;
    let address = get(r, 'address');
    const city = get(r, 'city'), st = get(r, 'state').toUpperCase().slice(0, 2), zip = get(r, 'zip');
    if (address && city && !address.includes(city)) address = `${address}, ${city}, ${st} ${zip}`.trim();
    const stateGuess = st || (address.match(/,\s*([A-Z]{2})\s+\d{5}/) || [])[1] || null;
    locations.push({
      row: i + 1, loc_no: get(r, 'loc_no') || String(locations.length + 1), name: get(r, 'name') || null, address: address || null, state: stateGuess,
      class_of_business: get(r, 'occupancy') || null, construction: get(r, 'construction') || null,
      year_built: num(get(r, 'year_built')), stories: num(get(r, 'stories')), square_feet: num(get(r, 'square_feet')),
      sprinklered: yesNo(get(r, 'sprinklered')), protection_class: num(get(r, 'protection_class')),
      tiv_building: b, tiv_contents: c, tiv_bi: bi, tiv: t ?? ((b || 0) + (c || 0) + (bi || 0))
    });
  }
  return locations.length ? { locations, declaredTotal } : null;
}

function mapLossRun(rows) {
  const h = findHeader(rows, LOSS, 3); if (!h) return null;
  const get = (r, f) => (h.map[f] === undefined ? '' : String(r[h.map[f]] ?? '').trim());
  const losses = [];
  for (let i = h.row + 1; i < rows.length; i++) {
    const r = rows[i];
    const dateStr = get(r, 'date'), year = +((dateStr.match(/(19|20)\d{2}/) || get(r, 'year').match(/(19|20)\d{2}/) || [])[0]);
    const paid = num(get(r, 'paid')), inc = num(get(r, 'incurred')), res = num(get(r, 'reserve'));
    if (!year || (paid === null && inc === null)) continue;
    const amount = inc ?? ((paid || 0) + (res || 0));
    let status = get(r, 'status') || null;
    if (!status && res) status = 'Open';
    losses.push({ row: i + 1, year, date: dateStr || null, cause: get(r, 'cause') || 'Not stated', paid: amount, reserve: res || 0, status, claim_no: get(r, 'claim_no') || null });
  }
  return losses.length ? { losses } : (rows.length > h.row + 1 ? { losses: [] } : null);
}

module.exports = { parseCSV, detectTable, mapSOV, mapLossRun, num, norm };
