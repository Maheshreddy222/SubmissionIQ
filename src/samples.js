// Sample submissions. Dates written as {{date+N}} are replaced with "today + N days" so demos never go stale.
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'samples');
const MIME = { txt: 'text/plain', csv: 'text/csv', png: 'image/png', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
const subst = (t) => t.replace(/\{\{date\+(\d+)\}\}/g, (_, n) => { const d = new Date(); d.setDate(d.getDate() + +n); return fmt(d); });
const index = () => JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).filter((s) => s.files.every((f) => fs.existsSync(path.join(DIR, f))));
function files(id) {
  const s = index().find((x) => x.id === id); if (!s) return null;
  return s.files.map((f) => {
    const ext = f.split('.').pop().toLowerCase(); let buffer = fs.readFileSync(path.join(DIR, f));
    if (['txt', 'csv'].includes(ext)) buffer = Buffer.from(subst(buffer.toString('utf8')));
    else if (ext === 'pdf') { /* dates in the sample PDF are generated once; keep binary as-is */ }
    return { name: f, buffer, mime: MIME[ext] || 'application/octet-stream' };
  });
}
module.exports = { index, files, subst };
