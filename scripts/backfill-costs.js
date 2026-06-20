#!/usr/bin/env node
// Backfill estimated generation cost into existing output/ and output/shorts/
// folders that predate live cost metering. Reconstructs cost from on-disk assets
// (image count + TTS length) at published API rates, and writes `cost` + `meta`
// (with backfilled:true) into each folder's script.json.
//
// Only touches folders that DON'T already have a `cost` (won't clobber live
// metered runs). Dry-run by default.
//   node scripts/backfill-costs.js                  # preview
//   node scripts/backfill-costs.js --apply           # write
//   node scripts/backfill-costs.js --force --apply   # also re-estimate folders
//        that already have a *backfilled* cost (never touches live-metered ones)

const fs = require('fs');
const path = require('path');
const { estimateFromFolder } = require('../utils/cost-meter');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const OUT = path.join(__dirname, '..', 'output');
const SHORTS = path.join(OUT, 'shorts');

function scan(dir, format) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'shorts')
    .map((e) => ({ folderPath: path.join(dir, e.name), name: e.name, format }));
}

const folders = [...scan(OUT, 'long'), ...scan(SHORTS, 'short')];
let updated = 0, skipped = 0, noData = 0;

for (const { folderPath, name, format } of folders) {
  const scriptPath = path.join(folderPath, 'script.json');
  let script;
  try { script = JSON.parse(fs.readFileSync(scriptPath, 'utf8')); } catch { continue; }

  // Skip folders that already have a cost — unless --force AND the existing cost
  // is itself a backfill (so we can re-estimate after a rate/logic change, but
  // never clobber a live-metered run).
  if (script.cost && !(FORCE && script.cost.backfilled)) { skipped++; continue; }

  const cost = estimateFromFolder(folderPath, { format });
  if (!cost) { noData++; console.log(`NO DATA: ${name}`); continue; }

  console.log(`${APPLY ? 'WRITE' : 'WOULD WRITE'} $${cost.total.toFixed(4)}  ${name}`);
  console.log(`           ${cost.items.map((i) => `${i.label}:${i.detail}`).join(' · ')}`);

  if (APPLY) {
    script.cost = cost;
    script.meta = Object.assign({
      type: format,
      resolution: format === 'short' ? '1080x1920' : '1920x1080',
      durationSec: typeof script.duration === 'number' ? script.duration : null,
      models: { image: 'gpt-image-1', tts: 'tts-1-hd' },
      backfilled: true,
    }, script.meta || {});
    fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  }
  updated++;
}

console.log(`\n${APPLY ? 'Wrote' : 'Would write'} ${updated} folder(s); ` +
  `skipped ${skipped} (already costed); ${noData} with no recoverable data.`);
if (!APPLY && updated) console.log('Re-run with --apply to write.');
