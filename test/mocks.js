// Local stand-ins for Gemini, the US Census geocoder and FEMA NFHL, so the AI and hazard code paths can be tested offline.
const http = require('http');
const { offlineExtract } = require('../src/extract');
const state = { geminiCalls: 0, rateLimited: false, log: [] };

function gemini() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (req.headers['x-goog-api-key'] !== 'test-key') return send(400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
      const b = JSON.parse(body); state.geminiCalls++;
      const schema = b.generationConfig?.responseSchema?.properties || {};
      if (schema.fields && !state.rateLimited) { state.rateLimited = true; return send(429, { error: { message: 'Quota exceeded (mock). Please retry.' } }, { 'Retry-After': '0' }); }
      let out;
      if (schema.status) out = { status: 'ok' };
      else if (schema.headline) out = { headline: 'Mock AI headline for the recommendation.', summary: 'Mock AI summary that explains the rules-based recommendation using the supplied facts.', strengths: ['Mock strength'], concerns: ['Mock concern (§2.2)'], broker_questions: ['Mock question?'],
        broker_email: 'Hi,\n\nThank you for your submission. This is a mock AI-written email used only for testing the Gemini integration path.\n\nBest regards,\nUnderwriting Team' };
      else if (schema.fields) {
        const parts = b.contents[0].parts; const fields = []; const docs = []; let cur = null, page = 1;
        for (const p of parts) {
          const m = p.text && p.text.match(/===== DOCUMENT "(.+?)" \(looks like: (\w+)\)/);
          if (m) { cur = m[1]; docs.push({ name: cur, type: m[2] }); page = 1; continue; }
          if (p.inlineData && cur) { // pretend OCR of the scanned self-storage form
            const ocr = [['insured_name', 'Summit Ridge Self Storage LLC', 'NAME OF INSURED: Summit Ridge Self Storage LLC'], ['address', '7420 Kingston Pike, Knoxville, TN 37919', 'PREMISES ADDRESS: 7420 Kingston Pike, Knoxville, TN 37919'],
              ['class_of_business', 'Self storage facility', 'DESCRIPTION OF OPERATIONS: Self storage facility'], ['construction', 'Masonry non-combustible', 'CONSTRUCTION TYPE: Masonry non-combustible'], ['year_built', '2018', 'YEAR BUILT: 2018'],
              ['stories', '1', 'NO. OF STORIES: 1'], ['square_feet', '45000', 'TOTAL AREA (SQ FT): 45,000'], ['sprinklered', 'false', 'SPRINKLERED (Y/N): N'], ['protection_class', '4', 'PROTECTION CLASS: 4'],
              ['tiv_building', '3800000', 'BUILDING AMOUNT: $3,800,000'], ['tiv_contents', '200000', 'CONTENTS AMOUNT: $200,000'], ['tiv_bi', '350000', 'BUSINESS INCOME AMOUNT: $350,000'], ['years_in_business', '5', 'YEARS IN BUSINESS: 5'],
              ['effective_date', '2027-04-15', 'PROPOSED EFF DATE: 04/15/2027'], ['prior_carrier', 'Volunteer State Mutual', 'PRIOR CARRIER: Volunteer State Mutual']];
            for (const [f, v, q] of ocr) fields.push({ field: f, value: v, confidence: f === 'protection_class' ? 0.55 : 0.88, document: cur, page: 1, quote: q });
            continue;
          }
          const pm = p.text && p.text.match(/^--- PAGE (\d+)/); if (pm) page = +pm[1];
          if (p.text && cur && !m) { // "LLM" reads text through the rules extractor, then adds a hallucination
            const raw = offlineExtract(p.text);
            for (const [k, v] of Object.entries(raw)) if (v !== null && k !== 'loss_history' && !Array.isArray(v)) { const q = p.text.split('\n').find((l) => l.toLowerCase().includes(String(v).toLowerCase())) || ''; fields.push({ field: k, value: String(v), confidence: 0.95, document: cur, page, quote: q.trim().slice(0, 120) }); }
            if (/Casa Verde/.test(p.text)) fields.push({ field: 'employees', value: '999', confidence: 0.9, document: cur, page, quote: 'about 999 employees across all sites' });
          }
        }
        out = { documents: docs, fields, loss_info_provided: false, loss_history: [], locations: [] };
      } else return send(400, { error: { message: 'unexpected schema in mock' } });
      send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } });
    });
  });
}
function gov() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname.includes('/geocoder/locations/onelineaddress')) {
      const a = u.searchParams.get('address') || ''; const fl = /Clearwater|Gulf Blvd/i.test(a);
      return send({ result: { addressMatches: [{ matchedAddress: a.toUpperCase(), coordinates: { x: fl ? -82.8 : -96.8, y: fl ? 27.97 : 32.8 } }] } });
    }
    if (/MapServer\/28\/query/.test(u.pathname)) {
      const lon = +u.searchParams.get('geometry').split(',')[0];
      return send({ features: [{ attributes: lon > -83.5 && lon < -82 ? { FLD_ZONE: 'AE', ZONE_SUBTY: 'FLOODWAY', SFHA_TF: 'T', STATIC_BFE: 9 } : { FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD', SFHA_TF: 'F' } }] });
    }
    if (/MapServer\/28$/.test(u.pathname)) return send({ editingInfo: { lastEditDate: Date.UTC(2026, 9, 2) } });
    res.writeHead(404); res.end();
  });
}
module.exports = { gemini, gov, state };
