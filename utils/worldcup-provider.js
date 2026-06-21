// FIFA World Cup match provider (football-data.org, competition code WC).
// Fetches FINISHED matches in a date window so the pipeline can make a recap
// video + Short per match.
//
// RATE LIMITING (important): football-data.org's free tier is ~10 requests/min
// and their docs explicitly say to watch the response headers for throttling.
// We read:
//   X-Requests-Available-Minute  - requests left in the current window
//   X-RequestCounter-Reset       - seconds until the window resets
// and on 429 we honor Retry-After. We also CACHE the day's match list in memory
// (TTL) so the daily task makes at most one /matches call, not one per video.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.football-data.org/v4';
const COMP = 'WC'; // FIFA World Cup
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min (responsive to just-finished matches while polling)

let _cache = { key: null, at: 0, data: null };
// Minimum ms to wait before the next request when the API says we're low.
let _throttleUntil = 0;

function apiKey() {
  const shortsConfig = require('./shorts-config');
  return shortsConfig.footballDataApiKey || process.env.FOOTBALL_DATA_API_KEY || null;
}

// GET JSON with rate-limit awareness. Returns { data, headers }. Throws on
// non-2xx (caller decides how to degrade). Respects an internal throttle gate
// set from prior responses.
function getJson(url, key, logger) {
  return new Promise((resolve, reject) => {
    const wait = Math.max(0, _throttleUntil - Date.now());
    setTimeout(() => {
      const req = https.get(url, { headers: { 'X-Auth-Token': key }, timeout: 10000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          // Read throttle headers and set the gate for the NEXT call.
          const left = parseInt(res.headers['x-requests-available-minute']);
          const reset = parseInt(res.headers['x-requestcounter-reset']);
          if (Number.isFinite(left) && left <= 1 && Number.isFinite(reset)) {
            _throttleUntil = Date.now() + (reset + 1) * 1000;
            if (logger) logger.warn(`football-data.org rate limit low (${left} left); throttling ~${reset}s`);
          }
          if (res.statusCode === 429) {
            const retry = parseInt(res.headers['retry-after']) || 60;
            _throttleUntil = Date.now() + retry * 1000;
            return reject(new Error(`429 rate limited; retry after ${retry}s`));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try { resolve({ data: JSON.parse(body), headers: res.headers }); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    }, wait);
  });
}

const fmt = (d) => d.toISOString().slice(0, 10);

// Normalize a football-data.org match object into our recap shape.
function normalizeMatch(m) {
  const home = m.homeTeam || {}, away = m.awayTeam || {};
  const ft = m.score?.fullTime || {};
  return {
    id: m.id,
    utcDate: m.utcDate,
    stage: m.stage,         // e.g. GROUP_STAGE, ROUND_OF_16, FINAL
    matchday: m.matchday,
    status: m.status,       // FINISHED, etc.
    homeTeam: home.shortName || home.name || 'Home',
    awayTeam: away.shortName || away.name || 'Away',
    homeScore: ft.home != null ? ft.home : null,
    awayScore: ft.away != null ? ft.away : null,
    homeCrestUrl: home.crest || null,
    awayCrestUrl: away.crest || null,
    competition: m.competition?.name || 'FIFA World Cup',
  };
}

// Fetch FINISHED World Cup matches within [from, to] (default: yesterday→today).
// Cached for CACHE_TTL_MS. Returns [] (never throws) so callers degrade safely.
async function getFinishedMatches({ from = null, to = null, logger = null } = {}) {
  const key = apiKey();
  if (!key) { if (logger) logger.warn('FOOTBALL_DATA_API_KEY not set; no WC matches'); return []; }

  const toD = to ? new Date(to) : new Date();
  const fromD = from ? new Date(from) : new Date(toD.getTime() - 1 * 864e5); // 1-day window (polling catches matches promptly)
  const cacheKey = `${fmt(fromD)}_${fmt(toD)}`;
  if (_cache.key === cacheKey && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.data;
  }

  const url = `${BASE}/competitions/${COMP}/matches?status=FINISHED&dateFrom=${fmt(fromD)}&dateTo=${fmt(toD)}`;
  try {
    const { data } = await getJson(url, key, logger);
    const matches = (data.matches || []).map(normalizeMatch)
      .filter((m) => m.homeScore != null && m.awayScore != null);
    _cache = { key: cacheKey, at: Date.now(), data: matches };
    if (logger) logger.info(`Fetched ${matches.length} finished WC match(es) [${cacheKey}]`);
    return matches;
  } catch (e) {
    if (logger) logger.warn(`WC match fetch failed: ${e.message}`);
    return [];
  }
}

// Local crest cache dir. Crests rarely change, so we store each one keyed by a
// hash of its URL and reuse it forever — no repeat fetches.
const CREST_DIR = path.join(__dirname, '..', 'data', 'crests');

function crestCachePath(url) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
  const ext = (path.extname(new URL(url).pathname) || '.png').split('?')[0] || '.png';
  return path.join(CREST_DIR, `${hash}${ext}`);
}

// Raw download (no cache). Supports https/http + small redirect chains.
function _fetchToFile(url, destPath, depth = 0) {
  return new Promise((resolve) => {
    if (!url || depth > 3) return resolve(null);
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
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

// Cache-first crest fetch: return the local copy if we already have it; else
// download, store it under data/crests/, and return the local path. Returns null
// if there's no URL or the fetch fails (caller renders the scoreboard without a
// crest). Pass an explicit destPath to override the cache location.
async function getCrest(url, destPath = null) {
  if (!url) return null;
  const target = destPath || crestCachePath(url);
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 100) return target; // cache hit
  } catch {}
  return _fetchToFile(url, target);
}

module.exports = { getFinishedMatches, getCrest, downloadCrest: getCrest, normalizeMatch };
