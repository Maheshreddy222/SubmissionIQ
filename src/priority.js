// Work-queue priority: which submissions need a human first, and why.
const SLA_HOURS = +process.env.SLA_HOURS || 4;
function daysUntil(iso) { if (!iso) return null; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? null : Math.ceil((d - new Date(new Date().toDateString())) / 864e5); }

function priority(r) {
  if (r.status === 'Processing') return { score: 0, level: 'Processing', reasons: ['Agents are working'], needsAttention: false };
  if (r.status === 'Error') return { score: 100, level: 'Critical', reasons: ['Processing failed'], needsAttention: true };
  const ex = r.extracted || {}, v = r.validation || {}, risk = r.risk || {};
  const decided = !!r.decision;
  const waitH = (Date.now() - new Date(r.created_at)) / 36e5;
  const days = daysUntil(ex.effective_date);
  const tiv = (ex.tiv_building || 0) + (ex.tiv_contents || 0) + (ex.tiv_bi || 0);
  let s = 0; const why = [];
  if (decided) return { score: 0, level: 'Done', reasons: ['Decision recorded'], needsAttention: false, dueInDays: days, waitingHours: null };
  s += 20; why.push('Awaiting underwriter review');
  if (days !== null) {
    if (days < 0) { s += 30; why.push(`Effective date passed ${-days} d ago`); }
    else if (days <= 7) { s += 30; why.push(`Effective in ${days} d`); }
    else if (days <= 14) { s += 20; why.push(`Effective in ${days} d`); }
    else if (days <= 30) { s += 10; why.push(`Effective in ${days} d`); }
  }
  if (risk.band === 'High') { s += 15; why.push(`High risk (${risk.score})`); } else if (risk.band === 'Elevated') { s += 8; why.push(`Elevated risk (${risk.score})`); }
  const cm = (v.criticalMissing || []).length; if (cm) { s += Math.min(15, cm * 5); why.push(`${cm} critical field${cm > 1 ? 's' : ''} missing`); }
  if (r.recommendation === 'Refer') { s += 10; why.push('Needs senior review'); }
  if (r.recommendation === 'Need Info') { s += 5; why.push('Waiting on broker information'); }
  if (tiv >= 10e6) { s += 10; why.push('TIV $10M+'); } else if (tiv >= 5e6) { s += 5; why.push('TIV $5M+'); }
  const low = (v.lowConfidence || []).length; if (low) { s += 5; why.push(`${low} low-confidence value${low > 1 ? 's' : ''} to verify`); }
  if (waitH >= SLA_HOURS) { s += Math.min(15, Math.round(waitH - SLA_HOURS) + 5); why.push(`Waiting ${waitH < 48 ? Math.round(waitH) + ' h' : Math.round(waitH / 24) + ' d'} (SLA ${SLA_HOURS} h)`); }
  s = Math.min(100, s);
  return { score: s, level: s >= 70 ? 'Critical' : s >= 50 ? 'High' : s >= 30 ? 'Medium' : 'Low', reasons: why, needsAttention: true, dueInDays: days, waitingHours: Math.round(waitH * 10) / 10, slaBreached: waitH >= SLA_HOURS };
}
module.exports = { priority, SLA_HOURS, daysUntil };
