#!/usr/bin/env node
// Seed the generated_content index from existing output folders so the
// DB-backed dashboard shows everything created before the index existed.
// Idempotent (upsertContent keys on folder). Dry-run by default.
//
//   node scripts/backfill-content-index.js          # preview
//   node scripts/backfill-content-index.js --apply   # write

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Database } = require('../database/db');
const { outputRoot, shortsRoot } = require('../utils/paths');

const APPLY = process.argv.includes('--apply');

// Scan one dir; defaultType is what to tag rows unless script.meta.matchRecap.
function scan(dir, defaultType) {
  const rows = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return rows; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'shorts' || e.name === 'longs') continue;
    const scriptPath = path.join(dir, e.name, 'script.json');
    let title = e.name, type = defaultType;
    try {
      const s = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
      title = s.title || title;
      if (s.meta && s.meta.matchRecap) type = 'match_recap';
    } catch { /* no script.json — still index by folder name */ }
    rows.push({ folder: e.name, type, title });
  }
  return rows;
}

(async () => {
  const db = new Database();
  await db.initialize();
  const rows = [...scan(outputRoot(), 'long'), ...scan(shortsRoot(), 'short')];
  for (const r of rows) {
    console.log(`${APPLY ? 'INDEX' : 'WOULD'}  ${r.type.padEnd(11)} ${r.folder}`);
    if (APPLY) await db.upsertContent(r);
  }
  const byType = rows.reduce((m, r) => ((m[r.type] = (m[r.type] || 0) + 1), m), {});
  console.log(`\n${APPLY ? 'Indexed' : 'Would index'} ${rows.length} folder(s): ${JSON.stringify(byType)}`);
  if (!APPLY) console.log('Re-run with --apply to write.');
  process.exit(0);
})();
