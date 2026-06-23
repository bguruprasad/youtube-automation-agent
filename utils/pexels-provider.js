// Pexels stock-video provider. Fetches GENERIC football/soccer B-roll (stadiums,
// crowds, pitches, anonymous players) to layer motion into Shorts. Pexels content
// is license-free for commercial use with no attribution required, and contains no
// real, identifiable players — so it's safe for monetized YouTube and carries no
// Content-ID risk (unlike actual match footage).
//
// MIRRORS the crest-cache pattern in worldcup-provider.js:
//   - cache-first: a clip for a given query is downloaded once into
//     data/stock-clips/<hash>.mp4 and reused forever (near-zero cost/latency on
//     repeat terms; the free tier is 200 req/hr / 20k req/mo).
//   - rate-limit aware: reads X-Ratelimit-Remaining and self-throttles.
//   - FAILS OPEN: any miss/error returns null so the caller falls back to a Flux
//     still. This module never throws.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEARCH_URL = 'https://api.pexels.com/videos/search';
const CLIP_DIR = path.join(__dirname, '..', 'data', 'stock-clips');
const SEARCH_TTL_MS = 60 * 60 * 1000; // cache a query's search result 1h

// query -> { at, fileUrl } so repeated scenes with the same query don't re-search.
const _searchCache = new Map();
let _throttleUntil = 0;

function apiKey() {
  const shortsConfig = require('./shorts-config');
  return (shortsConfig.stockClips && shortsConfig.stockClips.apiKey) || process.env.PEXELS_API_KEY || null;
}

function clipCachePath(query) {
  const hash = crypto.createHash('md5').update(query.toLowerCase().trim()).digest('hex').slice(0, 16);
  return path.join(CLIP_DIR, `${hash}.mp4`);
}

// GET JSON with the Pexels Authorization header, rate-limit aware. Resolves
// { data } on 2xx, rejects otherwise (caller degrades to null).
function getJson(url, key, logger) {
  return new Promise((resolve, reject) => {
    const wait = Math.max(0, _throttleUntil - Date.now());
    setTimeout(() => {
      const req = https.get(url, { headers: { Authorization: key }, timeout: 10000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const remaining = parseInt(res.headers['x-ratelimit-remaining']);
          const reset = parseInt(res.headers['x-ratelimit-reset']); // epoch seconds
          if (Number.isFinite(remaining) && remaining <= 2 && Number.isFinite(reset)) {
            _throttleUntil = reset * 1000;
            if (logger) logger.warn(`Pexels rate limit low (${remaining} left); throttling until reset`);
          }
          if (res.statusCode === 429) {
            _throttleUntil = Date.now() + 60000;
            return reject(new Error('429 rate limited'));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try { resolve({ data: JSON.parse(body) }); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    }, wait);
  });
}

// Raw download (no cache). Supports https/http + small redirect chains.
function _fetchToFile(url, destPath, depth = 0) {
  return new Promise((resolve) => {
    if (!url || depth > 4) return resolve(null);
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(_fetchToFile(res.headers.location, destPath, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const f = fs.createWriteStream(destPath);
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(destPath)));
      f.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

// From a Pexels video object, pick the best .mp4 file URL for our target
// orientation. Prefer an HD file whose aspect ratio matches (portrait for
// Shorts) and whose resolution is closest to (but >=) the target without being
// gigantic. Returns a URL or null.
function pickVideoFile(video, { portrait, targetW, targetH }) {
  const files = (video.video_files || []).filter((f) => f.link && /video\/mp4/i.test(f.file_type || 'video/mp4'));
  if (!files.length) return null;
  const score = (f) => {
    const w = f.width || 0, h = f.height || 0;
    if (!w || !h) return -1e9;
    const isPortrait = h >= w;
    const orientationOk = portrait ? isPortrait : !isPortrait;
    // Distance from target area; penalize wrong orientation heavily but don't
    // disqualify (a landscape clip can still blur-fill a vertical frame).
    const area = w * h, targetArea = targetW * targetH;
    let s = -Math.abs(area - targetArea) / targetArea;
    if (orientationOk) s += 5;
    // Prefer ~1080p-class; avoid 4K (huge downloads) and tiny SD.
    const maxDim = Math.max(w, h);
    if (maxDim >= 1080 && maxDim <= 2160) s += 2;
    else if (maxDim < 720) s -= 3;
    return s;
  };
  files.sort((a, b) => score(b) - score(a));
  return files[0].link;
}

/**
 * Get a local clip path for a search query, cache-first. Downloads + caches on
 * miss. Returns the local .mp4 path or null (caller falls back to a still).
 * Never throws.
 *
 * @param {string} query - search terms, e.g. "soccer stadium crowd night"
 * @param {object} opts  - { portrait, width, height, minSec, logger }
 */
async function getClip(query, opts = {}) {
  const key = apiKey();
  if (!key || !query) return null;
  const { portrait = true, width = 1080, height = 1920, minSec = 4, logger = null } = opts;

  const target = clipCachePath(query);
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 10000) return target; // cache hit
  } catch {}

  // Resolve the file URL (search cache avoids repeat API calls for same query).
  let fileUrl = null;
  const cached = _searchCache.get(query.toLowerCase().trim());
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) {
    fileUrl = cached.fileUrl;
  } else {
    const orientation = portrait ? 'portrait' : 'landscape';
    const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=15&size=medium`;
    try {
      const { data } = await getJson(url, key, logger);
      const candidates = (data.videos || []).filter((v) => (v.duration || 0) >= minSec);
      for (const v of candidates) {
        const u = pickVideoFile(v, { portrait, targetW: width, targetH: height });
        if (u) { fileUrl = u; break; }
      }
      _searchCache.set(query.toLowerCase().trim(), { at: Date.now(), fileUrl });
      if (logger) logger.info(`Pexels search "${query}": ${candidates.length} candidate(s)${fileUrl ? '' : ' (no usable file)'}`);
    } catch (e) {
      if (logger) logger.warn(`Pexels search failed for "${query}": ${e.message}`);
      return null;
    }
  }
  if (!fileUrl) return null;

  const out = await _fetchToFile(fileUrl, target);
  if (!out && logger) logger.warn(`Pexels clip download failed for "${query}"`);
  return out;
}

module.exports = { getClip };
