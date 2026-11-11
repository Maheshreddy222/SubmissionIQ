// Offline (rules-based) extraction + normalisation shared by LLM and offline paths.
const LABELS = {
  insured_name: ['name of insured', 'applicant name', 'named insured', 'insured', 'applicant', 'business name', 'account name'],
  address: ['premises address', 'location address', 'location', 'risk address', 'premises', 'address'],
  class_of_business: ['description of operations', 'primary operations', 'class / occupancy', 'class of business', 'occupancy', 'business description', 'operations', 'class'],
  years_in_business: ['years in business', 'years in operation', 'year established'],
  annual_revenue: ['annual revenue', 'annual sales', 'gross sales', 'revenue'],
  employees: ['number of employees', 'employees'],
  construction: ['construction type', 'construction'],
  year_built: ['year built', 'year of construction', 'built'],
  stories: ['no. of stories', '# of stories', 'number of stories', 'stories'],
  square_feet: ['total area (sq ft)', 'total area', 'area (sq ft)', 'square footage', 'square feet', 'building area', 'sq ft'],
  sprinklered: ['sprinklered (y/n)', 'sprinkler system', 'sprinklered', 'sprinklers'],
  protection_class: ['iso protection class', 'protection class', 'ppc'],
  tiv_building: ['building amount', 'building value', 'building limit', 'building tiv'],
  tiv_contents: ['contents amount', 'contents value', 'contents limit', 'business personal property', 'bpp'],
  tiv_bi: ['business income amount', 'business income value', 'business income', 'bi value', 'rental income'],
  effective_date: ['proposed eff date', 'proposed effective date', 'requested effective', 'effective date', 'inception'],
  prior_carrier: ['prior carrier', 'expiring carrier', 'current carrier', 'incumbent'],
  coverages_requested: ['coverages requested', 'coverage requested', 'coverages']
};
const FIELDS = [...Object.keys(LABELS), 'city', 'state', 'loss_history'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const m = String(v).match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(million|mm|m|thousand|k)?\b/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const u = (m[2] || '').toLowerCase();
  if (u === 'million' || u === 'mm' || u === 'm') n *= 1e6;
  if (u === 'thousand' || u === 'k') n *= 1e3;
  return Math.round(n);
}
const int = (v) => { const n = money(v); return n === null ? null : Math.round(n); };
function bool(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (/^(yes|y|true|full|partial|wet|dry)/.test(s)) return true;
  if (/^(no|n|none|false|not|unsprinklered)/.test(s)) return false;
  return null;
}
function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}


// ---- Heuristics for free-form broker emails (used only for fields the labelled pass did not find) ----
const CLASS_WORDS = ['vacant', 'pallet', 'sawmill', 'fireworks', 'cannabis', 'plastics', 'woodworking', 'cold storage', 'auto repair', 'garage', 'restaurant', 'bakery', 'cafe', 'tavern', 'bar', 'medical office', 'dental', 'clinic', 'office', 'warehouse', 'distribution', 'retail', 'strip center', 'shopping center', 'apartment', 'hotel', 'motel', 'self storage', 'manufacturing', 'church', 'school'];
const NUM = '([\\d.,]+(?:\\s?(?:million|mm|m|k)\\b)?)';
const NAME_STOP = new Set(['The', 'This', 'It', 'They', 'We', 'He', 'She', 'Building', 'Location', 'Please', 'Great']);
function prose(t) {
  const o = {};
  const m = (re) => t.match(re);
  let r;
  if ((r = m(/\b(\d{1,6}\s[A-Za-z0-9'-]+\.?(?: [A-Za-z0-9'-]+\.?){0,4},\s*[\w .'-]+?,\s*[A-Z]{2}\s+\d{5})/))) o.address = r[1];
  if ((r = m(/(?:built|constructed)(?: in)? (\d{4})|\b(\d{4}) (?:construction|build)\b/i))) o.year_built = r[1] || r[2];
  if ((r = m(/([\d,]{3,7})\s*(?:sq\.? ?ft|sf|square f(?:ee|oo)t|sqft)\b/i))) o.square_feet = r[1];
  if ((r = m(/(\d+)[- ]stor(?:y|ies)\b/i))) o.stories = r[1];
  else if ((r = m(/\b(one|single|two|three|four|five)[- ]stor(?:y|ies)\b/i))) o.stories = { one: 1, single: 1, two: 2, three: 3, four: 4, five: 5 }[r[1].toLowerCase()];
  const CONS = [/masonry non-?combustible/i, /non-?combustible/i, /fire[- ]resistive/i, /joisted masonry/i, /tilt-up/i, /wood[- ]frame|frame construction|frame building/i];
  for (const re of CONS) { if ((r = m(re))) { o.construction = r[0]; break; } }
  if (/\b(no|not|without|un)[- ]?sprinkler/i.test(t)) o.sprinklered = 'no';
  else if (/sprinkler|\bESFR\b/i.test(t)) o.sprinklered = 'yes';
  if ((r = m(/(?:protection class|\bPPC\b)(?: is| of)?[: ]*(\d{1,2})\b/i))) o.protection_class = r[1];
  if ((r = m(/in business (?:for )?(\d+)\+? years|(\d+)\+? years in business|in business since (\d{4})|established (?:in )?(\d{4})/i))) o.years_in_business = r[1] || r[2] || r[3] || r[4];
  if ((r = m(/(\d[\d,]*)\s+(?:full[- ]time )?employees/i))) o.employees = r[1];
  if ((r = m(new RegExp('(?:annual (?:sales|revenue|receipts)|gross sales|revenues?)[^.\\n$]{0,25}?\\$\\s?' + NUM, 'i')))) o.annual_revenue = r[1];
  if ((r = m(new RegExp('building[^.\\n$]{0,30}?\\$\\s?' + NUM, 'i')))) o.tiv_building = r[1];
  if ((r = m(new RegExp('contents[^.\\n$]{0,30}?\\$\\s?' + NUM, 'i')))) o.tiv_contents = r[1];
  if ((r = m(new RegExp('(?:business income|\\bBI\\b)[^.\\n$]{0,40}?\\$\\s?' + NUM, 'i')))) o.tiv_bi = r[1];
  if ((r = m(/(?:effective|eff\.?|inception|for)[^.\n\d]{0,20}(\d{1,2}\/\d{1,2}\/\d{2,4})/i))) o.effective_date = r[1];
  if ((r = m(/(?:[Cc]urrent|[Pp]rior|[Ee]xpiring|[Ii]ncumbent) (?:carrier|insurer)(?: is|:)?\s+([A-Z][\w&.' -]{2,40}?)(?=[.,;\n]|\s+for\b|\s+and\b|$)/))) o.prior_carrier = r[1].trim();
  const lower = t.toLowerCase();
  const hit = CLASS_WORDS.find((w) => new RegExp('\\b' + w.replace(/ /g, '[ -]') + '\\b').test(lower));
  if (hit) o.class_of_business = hit;
  for (const c of t.matchAll(/\b([A-Z][\w&'.-]*(?: [A-Z&][\w&'.-]*){0,4}) is an? /g)) {
    if (!NAME_STOP.has(c[1]) && c[1].length > 3) { o.insured_name = c[1]; break; }
  }
  if (!o.insured_name) {
    const sub = (t.match(/^Subject:\s*(.+)$/im) || [])[1];
    if (sub) {
      const seg = sub.split(/\s[-\u2013|:]\s/).map((x) => x.replace(/\(.*?\)/g, '').trim()).find((x) => x && !/^(re|fwd?|new|submission|quote|rfq|property|commercial|renewal|request|remarketing|business)\b/i.test(x));
      if (seg) o.insured_name = seg;
    }
  }
  return o;
}

function lossesFromText(text) {
  const loss = [];
  const toNum = (v) => { const n = money(v); return n === null ? 0 : n; };
  const re = /^[ \t]*((?:19|20)\d{2})[ \t]*[-\u2013:|][ \t]*(.+?)[ \t]*[-\u2013,|][ \t]*\$([\d,]+(?:\.\d+)?k?)(?:[ \t]*[-\u2013,|][ \t]*(.*))?$/gm;
  let m;
  while ((m = re.exec(text))) loss.push({ year: +m[1], cause: m[2].trim(), paid: toNum(m[3]), status: (m[4] || '').trim() || null });
  return loss;
}

function offlineExtract(text) {
  const out = {}, methods = {};
  for (const [field, labels] of Object.entries(LABELS)) {
    const alt = [...labels].sort((a, b) => b.length - a.length).map(esc).join('|');
    const m = text.match(new RegExp(`^[ \\t]*(?:[-*\u2022][ \\t]*)?(?:${alt})[ \\t]*[:\\-\u2013][ \\t]*(.+?)[ \\t]*$`, 'im'));
    out[field] = m ? m[1].trim() : null;
    if (m) methods[field] = 'label';
  }
  const loss = [];
  const re = /^[ \t]*((?:19|20)\d{2})[ \t]*\|[ \t]*([^|\n]+?)[ \t]*\|[ \t]*\$?([\d,]+)[ \t]*(?:\|[ \t]*(.*))?$/gm;
  let m;
  while ((m = re.exec(text))) loss.push({ year: +m[1], cause: m[2], paid: +m[3].replace(/,/g, ''), status: (m[4] || '').trim() || null });
  if (!loss.length) loss.push(...lossesFromText(text));
  if (loss.length) out.loss_history = loss;
  else if (/\b(no (known |reported )?(losses|claims)|loss[- ]free|claims[- ]free)\b/i.test(text)) out.loss_history = [];
  else out.loss_history = null;
  const p = prose(text);
  for (const k of Object.keys(p)) if (out[k] === null || out[k] === undefined) { out[k] = p[k]; methods[k] = 'prose'; }
  Object.defineProperty(out, '__methods', { value: methods, enumerable: false });
  return out;
}

function normalize(raw) {
  const ex = {};
  for (const k of FIELDS) ex[k] = raw[k] === undefined || raw[k] === '' ? null : raw[k];
  ex.insured_name = ex.insured_name ? String(ex.insured_name).trim() : null;
  if (ex.address && (!ex.state || !ex.city)) {
    const m = String(ex.address).match(/,\s*([^,]+),\s*([A-Za-z]{2})\.?\s+\d{5}/);
    if (m) { ex.city = ex.city || m[1].trim(); ex.state = ex.state || m[2]; }
  }
  ex.state = ex.state ? String(ex.state).trim().toUpperCase().slice(0, 2) : null;
  for (const k of ['annual_revenue', 'tiv_building', 'tiv_contents', 'tiv_bi']) ex[k] = money(ex[k]);
  for (const k of ['employees', 'year_built', 'stories', 'square_feet', 'protection_class']) ex[k] = int(ex[k]);
  if (ex.years_in_business !== null) {
    let y = int(ex.years_in_business);
    if (y && y > 1800) y = new Date().getFullYear() - y; // "established 2005"
    ex.years_in_business = y;
  }
  ex.sprinklered = bool(ex.sprinklered);
  ex.effective_date = isoDate(ex.effective_date);
  if (typeof ex.coverages_requested === 'string') ex.coverages_requested = ex.coverages_requested.split(/,|;|\band\b/i).map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(ex.coverages_requested)) ex.coverages_requested = null;
  if (Array.isArray(ex.loss_history)) {
    ex.loss_history = ex.loss_history.map((l) => ({ year: int(l.year), cause: l.cause || null, paid: money(l.paid) || 0, status: l.status || null }));
  } else if (ex.loss_history !== null) ex.loss_history = null;
  return ex;
}

module.exports = { offlineExtract, normalize, FIELDS };
