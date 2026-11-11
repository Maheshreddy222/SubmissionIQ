// Location hazard lookup. One reliable, free, official source to start: FEMA National Flood Hazard Layer,
// with the US Census geocoder to turn an address into coordinates. Other hazards are shown as "not assessed" on purpose.
const db = require('./db');
const CENSUS = () => (process.env.CENSUS_BASE_URL || 'https://geocoding.geo.census.gov').replace(/\/$/, '');
const FEMA = () => (process.env.FEMA_NFHL_URL || 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer').replace(/\/$/, '');
const LAYER = () => process.env.FEMA_FLOOD_LAYER || '28'; // "Flood Hazard Zones"
const TTL_MS = 30 * 864e5;

async function getJSON(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'SubmissionIQ-prototype' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function geocode(address) {
  const d = await getJSON(`${CENSUS()}/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`);
  const m = d.result?.addressMatches?.[0];
  return m ? { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress } : null;
}
function classifyFlood(a) {
  const zone = a.FLD_ZONE || null, sub = a.ZONE_SUBTY || '', sfha = a.SFHA_TF === 'T' || a.SFHA_TF === true;
  let level = null, description = '';
  if (sfha || /^(A|V)/i.test(zone || '')) { level = 'high'; description = 'Special Flood Hazard Area (1% annual-chance flood zone)'; }
  else if (/^X/i.test(zone || '') && /0\.2|shaded|reduced|levee/i.test(sub)) { level = 'moderate'; description = 'Moderate flood hazard (0.2% annual-chance area or reduced risk due to levee)'; }
  else if (/^X/i.test(zone || '')) { level = 'minimal'; description = 'Area of minimal flood hazard'; }
  else if (/^D/i.test(zone || '')) { level = null; description = 'Flood hazard undetermined'; }
  else { description = 'Flood zone not classified'; }
  return { zone, subtype: sub || null, sfha, level, description };
}
async function flood(lat, lon) {
  const q = `${FEMA()}/${LAYER()}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE&returnGeometry=false&f=json`;
  const d = await getJSON(q, 10000);
  if (d.error) throw new Error(d.error.message || 'FEMA service error');
  const attrs = d.features?.[0]?.attributes;
  let updated = null;
  try { const info = await getJSON(`${FEMA()}/${LAYER()}?f=json`, 5000); const t = info.editingInfo?.lastEditDate; if (t) updated = new Date(t).toISOString().slice(0, 10); } catch (e) { /* metadata date is optional */ }
  return { ...(attrs ? classifyFlood(attrs) : { zone: null, subtype: null, sfha: false, level: null, description: 'No flood zone mapped at this location (area may not be mapped by FEMA)' }), mapped: !!attrs, sourceUpdated: updated, url: q };
}

async function lookup(address, { force = false } = {}) {
  const retrievedBase = { retrieved: new Date().toISOString().slice(0, 10) };
  const fire = { status: 'not_assessed', note: 'No verified fire-station data source is configured. The broker-declared ISO protection class is used instead and is unverified.' };
  const wild = { status: 'not_assessed', note: 'Wildfire exposure needs a verified data source (for example a state or USFS wildfire hazard layer). Not configured, so not assessed.' };
  if (process.env.HAZARD_LOOKUP === 'off') return { status: 'disabled', address, fire_service: fire, wildfire: wild };
  if (!address) return { status: 'no_address', address, fire_service: fire, wildfire: wild };
  const key = address.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!force) { const c = db.prepare('SELECT value, fetched_at FROM hazards WHERE key=?').get(key); if (c && Date.now() - new Date(c.fetched_at) < TTL_MS) return { ...JSON.parse(c.value), cached: true }; }
  try {
    const g = await geocode(address);
    if (!g) return { status: 'not_found', address, error: 'The address could not be geocoded.', fire_service: fire, wildfire: wild };
    const fl = await flood(g.lat, g.lon);
    const out = { status: 'ok', address, geocode: { ...g, source: 'US Census Geocoder', ...retrievedBase },
      flood: { ...fl, source: 'FEMA National Flood Hazard Layer (NFHL)', ...retrievedBase }, fire_service: fire, wildfire: wild };
    db.prepare('INSERT OR REPLACE INTO hazards (key, value, fetched_at) VALUES (?,?,?)').run(key, JSON.stringify(out), new Date().toISOString());
    return out;
  } catch (e) {
    return { status: 'unavailable', address, error: `Hazard data source unavailable: ${String(e.message).slice(0, 120)}`, fire_service: fire, wildfire: wild };
  }
}
module.exports = { lookup, classifyFlood };
