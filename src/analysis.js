// Deterministic assessment pipeline shared by the server and the tests.
const E = require('./engine');
const { scoreAccount, loadModel } = require('./risk');
const { screenAll, loadValuation } = require('./valuation');

function assess(ex, { evidence = {}, conflicts = [], locations = [], declaredTotal = null, hazard = null, hazardByLoc = null, unread = [], guidelines = E.loadGuidelines() } = {}) {
  const validation = E.validate(ex, { evidence, conflicts, unread });
  const valuation = screenAll(ex, locations, loadValuation());
  const valuationByLoc = valuation.byLocation || null;
  const risk = scoreAccount(ex, { evidence, hazard, valuation, valuationByLoc, hazardByLoc }, locations, loadModel());
  const checks = E.evaluateAppetite(ex, guidelines, { valuation, hazard });
  const decision = E.decide(validation, checks, ex);
  return { validation, valuation, risk, checks, recommendation: decision.recommendation, quality: decision.score };
}
module.exports = { assess };
