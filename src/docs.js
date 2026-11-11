// Document ingestion: PDF (per-page text), images (for Gemini OCR), spreadsheets, CSV and plain text.
const T = require('./tabular');
let XLSX = null; try { XLSX = require('xlsx'); } catch (e) { /* optional */ }
const IMG = /\.(png|jpe?g|webp)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', eml: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12' };
const fixMime = (name, given) => (!given || given === 'application/octet-stream' ? MIME[name.split('.').pop().toLowerCase()] || 'text/plain' : given);

function classify(name, text, tables) {
  const n = name.toLowerCase(), t = (text || '').slice(0, 5000).toLowerCase();
  for (const tb of tables || []) { const k = T.detectTable(tb.rows); if (k) return k; }
  if (/\bsov\b|schedule of values|statement of values/.test(n)) return 'sov';
  if (/loss[ _-]?run|claims?[ _-]?history|currently[ _-]?valued/.test(n) || /loss run|date of loss.*(paid|incurred)/s.test(t)) return 'loss_run';
  if (/acord/.test(n) || /acord\s*\d{3}|commercial insurance application|property section/.test(t)) return 'acord';
  if (/^(from|subject|to):/m.test(t) || /\.(eml|txt)$/.test(n)) return 'email';
  return 'other';
}

async function pdfPagesWith(buffer, version) {
  const pdf = require('pdf-parse');
  const pages = [];
  await pdf(buffer, {
    version,
    pagerender: async (pd) => {
      const tc = await pd.getTextContent(); let t = '', lastY;
      for (const it of tc.items) {
        const y = it.transform[5];
        if (lastY === undefined || Math.abs(lastY - y) < 2) t += (t && !/\s$/.test(t) && !/^\s/.test(it.str) ? ' ' : '') + it.str; else t += '\n' + it.str;
        lastY = y;
      }
      pages.push(t); return t;
    }
  });
  return pages;
}
// Different PDF engines tolerate different files; try the newest first.
async function pdfPages(buffer) {
  let err;
  for (const v of ['v2.0.550', 'v1.10.100', 'v1.10.88']) { try { return await pdfPagesWith(buffer, v); } catch (e) { err = e; } }
  throw new Error('Could not read this PDF (' + (err && err.message) + '). If it is scanned or protected, upload it as images or set GEMINI_API_KEY.');
}

async function ingest({ buffer, name, mime }) {
  const lower = name.toLowerCase(); let pages = [], tables = [], scanned = false;
  if (/\.pdf$/.test(lower) || mime === 'application/pdf') {
    const ps = await pdfPages(buffer);
    pages = ps.map((t, i) => ({ n: i + 1, label: `Page ${i + 1}`, text: t.trim() }));
    scanned = pages.length === 0 || pages.reduce((s, p) => s + p.text.length, 0) / pages.length < 80;
    mime = 'application/pdf';
  } else if (IMG.test(lower)) {
    pages = [{ n: 1, label: 'Image', text: '' }]; scanned = true; mime = MIME[lower.split('.').pop()] || mime;
  } else if (/\.(xlsx|xls|xlsm)$/.test(lower)) {
    if (!XLSX) throw new Error('Excel support needs the "xlsx" package. Run: npm install');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    wb.SheetNames.forEach((sn, i) => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' }).filter((r) => r.some((c) => String(c).trim() !== ''));
      pages.push({ n: i + 1, label: sn, text: rows.map((r) => r.join(' | ')).join('\n') }); tables.push({ page: i + 1, sheet: sn, rows });
    });
  } else {
    const text = buffer.toString('utf8');
    if (/\.(csv|tsv)$/.test(lower)) { const rows = T.parseCSV(text); pages = [{ n: 1, label: 'Sheet', text }]; tables.push({ page: 1, sheet: 'Sheet', rows }); }
    else pages = text.split('\f').map((t, i) => ({ n: i + 1, label: `Page ${i + 1}`, text: t.trim() }));
  }
  const kind = classify(name, pages.map((p) => p.text).join('\n'), tables);
  return { name, mime: fixMime(name, mime), kind, pages, tables, scanned };
}

module.exports = { ingest, classify };
