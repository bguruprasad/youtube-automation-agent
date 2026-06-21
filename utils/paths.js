// Single source of truth for the generated-content output location.
// OUTPUT_DIR (in .env) is the base; long videos and shorts get parallel
// subdirs under it. Override with OUTPUT_DIR to move all generated media
// outside the repo (keeps the repo lean and out of graphify/git noise).
// OUTPUT_DIR may be absolute or relative to the repo root.
//
//   baseRoot()    -> OUTPUT_DIR (default: <repo>/output)
//   outputRoot()  -> long videos:  <OUTPUT_DIR>/longs
//   shortsRoot()  -> shorts:       <OUTPUT_DIR>/shorts
//
// Both subdirs derive from the same base so the layout stays symmetric.
// SHORTS_OUTPUT_DIR still overrides the shorts location if set (legacy escape
// hatch), absolute or repo-relative.

const path = require('path');
const REPO_ROOT = path.join(__dirname, '..');

function baseRoot() {
  const env = process.env.OUTPUT_DIR;
  if (!env) return path.join(REPO_ROOT, 'output');
  return path.isAbsolute(env) ? env : path.join(REPO_ROOT, env);
}

function outputRoot() {
  return path.join(baseRoot(), 'longs');
}

function shortsRoot() {
  const env = process.env.SHORTS_OUTPUT_DIR;
  if (env) return path.isAbsolute(env) ? env : path.join(REPO_ROOT, env);
  return path.join(baseRoot(), 'shorts');
}

module.exports = { baseRoot, outputRoot, shortsRoot, REPO_ROOT };
