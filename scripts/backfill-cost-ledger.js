#!/usr/bin/env node
// Seed the cost_ledger table from the cost blocks already stored in each
// output folder's script.json. Idempotent (recordCost dedupes by folder ref),
// so it's safe to re-run. Dated by the folder's timestamp prefix
// (YYYY-MM-DD_...) when present, else the folder mtime.
//
//   node scripts/backfill-cost-ledger.js          # preview
//   node scripts/backfill-cost-ledger.js --apply   # write

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Database } = require('../database/db');

const APPLY = process.argv.includes('--apply');
const { outputRoot, shortsRoot } = require('../utils/paths');
const OUT = outputRoot();
const SHORTS = shortsRoot();

// category for a folder: shorts dir -> short or match_recap; output dir -> video
// or match_recap. We tag match recaps via script.meta.matchRecap.
function folderDate(name, fullPath) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try { const t = fs.statSync(fullPath).mtime; const p = n => String(n).padStart(2,'0');
    return `${t.getFullYear()}-${p(t.getMonth()+1)}-${p(t.getDate())}`; } catch { return null; }
}

function scan(dir, defaultCat) {
  const rows = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return rows; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'shorts') continue;
    const full = path.join(dir, e.name);
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(full, 'script.json'), 'utf8')); } catch { continue; }
    const total = s.cost && typeof s.cost.total === 'number' ? s.cost.total : 0;
    if (!(total > 0)) continue;
    const category = s.meta && s.meta.matchRecap ? 'match_recap' : defaultCat;
    rows.push({ ref: e.name, category, amount: total, date: folderDate(e.name, full), detail: s.title || e.name });
  }
  return rows;
}

(async () => {
  const db = new Database();
  await db.initialize();
  const rows = [...scan(OUT, 'video'), ...scan(SHORTS, 'short')];
  let total = 0;
  for (const r of rows) {
    total += r.amount;
    console.log(`${APPLY ? 'WRITE' : 'WOULD'}  ${r.date}  ${r.category.padEnd(11)} $${r.amount.toFixed(4)}  ${r.detail.slice(0,40)}`);
    if (APPLY) await db.recordCost(r);
  }
  console.log(`\n${APPLY ? 'Wrote' : 'Would write'} ${rows.length} ledger rows, total $${total.toFixed(2)}.`);
  if (!APPLY) console.log('Re-run with --apply to write.');
  process.exit(0);
})();
