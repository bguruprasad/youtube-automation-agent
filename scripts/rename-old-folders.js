#!/usr/bin/env node
// One-off migration: rename legacy date-only output folders
//   <YYYY-MM-DD>_<slug>   ->   <YYYY-MM-DD_HH-MM-SS>_<slug>
// so they sort chronologically by name (matching new-folder naming). The time
// component is taken from each folder's actual mtime (true creation order).
//
// Dry-run by default. Pass --apply to actually rename.
//   node scripts/rename-old-folders.js          # preview
//   node scripts/rename-old-folders.js --apply   # do it

const fs = require('fs');
const path = require('path');
const { folderTimestamp } = require('../utils/timestamp');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..', 'output');
const DIRS = [ROOT, path.join(ROOT, 'shorts')];

// Matches a leading date-only prefix that has NOT already got a time component.
// Old: 2026-06-19_slug
// New: 2026-06-19_14-30-00_slug  (date "_" HH-MM-SS "_") -> skip
// The negative lookahead must require the FULL HH-MM-SS_ shape, not just two
// digits, otherwise a slug like "10-unforgettable-..." is wrongly treated as
// already-timestamped.
const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})_(?!\d{2}-\d{2}-\d{2}_)/;

let planned = 0, skipped = 0;

for (const dir of DIRS) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'shorts') continue; // the shorts container itself
    const m = e.name.match(DATE_ONLY);
    if (!m) { skipped++; continue; } // already timestamped or unrecognized

    const full = path.join(dir, e.name);
    const slug = e.name.slice(m[1].length + 1); // everything after "YYYY-MM-DD_"
    const mtime = fs.statSync(full).mtime;
    const newName = `${folderTimestamp(mtime)}_${slug}`;
    const target = path.join(dir, newName);

    if (fs.existsSync(target)) {
      console.log(`SKIP (target exists): ${e.name} -> ${newName}`);
      skipped++;
      continue;
    }
    console.log(`${APPLY ? 'RENAME' : 'WOULD RENAME'}: ${e.name}\n            -> ${newName}`);
    planned++;
    if (APPLY) fs.renameSync(full, target);
  }
}

console.log(`\n${APPLY ? 'Renamed' : 'Would rename'} ${planned} folder(s); skipped ${skipped}.`);
if (!APPLY && planned) console.log('Re-run with --apply to perform the rename.');
