// Single source of truth for the generated-content output location.
// Default: <repo>/output. Override with OUTPUT_DIR in .env to move all
// generated videos/shorts outside the repo (keeps the repo lean and out of
// graphify/git noise). OUTPUT_DIR may be absolute or relative to the repo root.
//
//   outputRoot()   -> base dir for long-video runs (output/<run>/)
//   shortsRoot()   -> base dir for shorts (output/shorts/ by default)
//
// Shorts default to <outputRoot>/shorts but can be overridden independently
// with SHORTS_OUTPUT_DIR (kept for backward compatibility).

const path = require('path');
const REPO_ROOT = path.join(__dirname, '..');

function outputRoot() {
  const env = process.env.OUTPUT_DIR;
  if (!env) return path.join(REPO_ROOT, 'output');
  return path.isAbsolute(env) ? env : path.join(REPO_ROOT, env);
}

function shortsRoot() {
  const env = process.env.SHORTS_OUTPUT_DIR;
  if (env) return path.isAbsolute(env) ? env : path.join(REPO_ROOT, env);
  return path.join(outputRoot(), 'shorts');
}

module.exports = { outputRoot, shortsRoot, REPO_ROOT };
