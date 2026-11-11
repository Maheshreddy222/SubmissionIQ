# SubmissionIQ - Underwriting Submission Copilot

Agentic AI for commercial property underwriting. It reads broker submissions (emails, ACORD forms, PDFs, scans,
schedules of values, loss runs), scores property risk, screens valuation and flood exposure, applies your guidelines,
and gives the underwriter a decision-ready file with the evidence behind every number.
**Rules decide. AI explains. Humans approve.**

## Run it
```bash
npm install
cp .env.example .env     # add GEMINI_API_KEY 
npm start                # landing page: http://localhost:3000   app: http://localhost:3000/app
```
Requires Node 22.5+ (built-in SQLite). Then open **Guidelines & AI -> Test AI connection** to confirm your key, model and quota work.


## What it does
| Capability | How it works |
|---|---|
| **Property risk score (0-100, higher = riskier)** | Separate from completeness. Factors: construction, building age, fire protection (sprinklers + ISO class), occupancy hazard, loss history (frequency, severity, fire/electrical causes, open claims), exposure size, flood location, insured-value adequacy. Every factor shows points, reason and evidence. Configure in `data/risk_model.json`. A combustible, unsprinklered warehouse with fire claims scores ~84 (High); a sprinklered fire-resistive office ~14 (Low). Multi-location accounts get per-location scores. |
| **Document processing** | Multiple files per submission. Text PDFs are read per page. Scans and images are read with Gemini OCR. CSV/Excel schedules of values (SOV) and loss runs are parsed directly, totals are reconciled, and conflicts between documents are flagged. |
| **Evidence and corrections** | Every extracted value shows document, page, quote and a confidence indicator. AI quotes are checked against the document text, and agreement with the rules extractor raises confidence. Reviewers correct a value in one click; checks re-run and the correction is logged. |
| **Location hazards** | US Census geocoder + FEMA National Flood Hazard Layer for flood zone, with source and dates. Wildfire and fire-station distance are shown as *not assessed* because no verified source is configured. Set `HAZARD_LOOKUP=off` to disable. |
| **Valuation screening** | Declared building value vs an estimated replacement-cost range (occupancy x construction x region x area). Flags possible underinsurance and unusually high values. Screening estimate only, not a certified valuation. Benchmarks in `data/valuation.json` are illustrative defaults. |
| **Work queue** | Ranks by urgency (effective date), risk, missing information, review status, TIV and waiting time vs SLA. Shows what needs a human first, plus processing and time-to-decision metrics. |
| **Explainability and audit** | Each recommendation shows the rule, the inputs with their sources, failed checks, guideline version, reviewer, approval time and override reason. Export a full decision record as JSON. |

## Pipeline (8 agents)
Document -> Validation -> Location -> Valuation -> Risk scoring -> Appetite -> Risk summary -> Broker email.
Only Document, Risk summary and Broker email use AI. Everything that decides is deterministic.

## Gemini reliability features
Structured JSON output with schemas, automatic retry with backoff (respects Retry-After), call spacing for free-tier limits,
model fallback, response caching (no repeat charges on re-runs), key redaction in errors, and a one-click connection test.
If the AI is unavailable, each step falls back to rules and the pipeline still completes.

## Tests (run offline)
```bash
npm test
```
`test/smoke.js` checks all 15 samples, risk ordering, SOV/loss-run merging, page-level evidence and priority ranking.
`test/integration.js` starts the server against **mock** Gemini, FEMA and Census services and checks AI extraction, OCR path,
rate-limit retry, hallucination guard, hazards, corrections, decisions, record export and invalid-key handling.

## Honest limits
- The AI and hazard code paths have been tested against **mock servers**, not the live Gemini, FEMA or Census services. Use *Test AI connection* and run a few samples with your key to confirm real-world behaviour.
- The app has only been tried on 15 synthetic submissions, never on real broker documents. Build an evaluation set from anonymised real submissions and measure per-field accuracy before relying on it.
- Guidelines, the risk model and valuation benchmarks are illustrative defaults, not any carrier's.
- FEMA flood zone lookup depends on the live FEMA service; the layer ID can change (`FEMA_FLOOD_LAYER`, `FEMA_NFHL_URL`).
- Corrections cover single fields, not individual loss rows or locations.
- No Guidewire/Duck Creek integration yet.

## Project layout
```
server.js              API + static files
src/llm.js             Gemini client (schemas, retry, fallback, cache, test)
src/llmExtract.js      AI document extraction with evidence verification
src/docs.js            PDF/image/CSV/Excel ingestion
src/tabular.js         SOV and loss-run parsing
src/intake.js          Merge documents into one record with per-field evidence
src/risk.js            Property risk score        data/risk_model.json
src/valuation.js       Replacement-cost screening data/valuation.json
src/hazards.js         FEMA flood lookup
src/engine.js          Validation + guideline checks   data/guidelines.json
src/priority.js        Work-queue ranking
src/pipeline.js        The 8-step pipeline
public/                Landing page and app
data/samples/          15 synthetic submissions (emails, ACORD PDF, scan, SOV + loss runs)
test/                  Offline tests and mock services
```
