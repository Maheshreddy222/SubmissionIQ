const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const file = process.env.DB_FILE || path.join(dir, 'submissioniq.db');

// Node >= 22.5 ships SQLite built in (no native build needed); older Node falls back to better-sqlite3.
let db;
try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(file);
} catch (e) {
  try { const Database = require('better-sqlite3'); db = new Database(file); }
  catch (e2) { throw new Error('SQLite unavailable: use Node 22.5+ (built-in) or run "npm install better-sqlite3". ' + e2.message); }
}
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  source_name TEXT,
  raw_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Processing',
  recommendation TEXT,
  score INTEGER,
  insured TEXT,
  extracted TEXT, validation TEXT, appetite TEXT, summary TEXT,
  broker_email TEXT, decision TEXT,
  provider TEXT, processing_ms INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_sub ON audit(submission_id);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL, name TEXT, mime TEXT, kind TEXT,
  pages INTEGER, scanned INTEGER DEFAULT 0, content TEXT, path TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_sub ON documents(submission_id);
CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, value TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS hazards (key TEXT PRIMARY KEY, value TEXT, fetched_at TEXT);
`);
for (const col of ['evidence', 'locations', 'risk', 'valuation', 'hazards', 'conflicts']) {
  try { db.exec(`ALTER TABLE submissions ADD COLUMN ${col} TEXT`); } catch (e) { /* already exists */ }
}
module.exports = db;
