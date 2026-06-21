// Second-source score cross-check (API-Football, api-sports.io v3).
//
// Why: our primary feed (football-data.org) once published a wrong full-time
// score (Spain 5-0 Saudi Arabia; real result 4-0). Before generating a recap we
// confirm the score against an independent provider. On DISAGREEMENT the WC task
// skips the match and retries next cycle, by which time one provider has usually
// corrected. See utils/worldcup-provider.js for the primary feed.
//
// FAIL-OPEN: if API_FOOTBALL_KEY is unset or the lookup fails/times out, we
// return { ok: true, checked: false } so behavior matches the pre-crosscheck
// pipeline (never block generation on the second source being down). The caller
// only skips on an explicit confirmed MISMATCH.
//
// API-Football v3: host v3.football.api-sports.io, auth header x-apisports-key.
// Endpoint: GET /fixtures?date=YYYY-MM-DD&...  goals are in fixture.goals.{home,away}.

const https = require('https');

const HOST = 'v3.football.api-sports.io';

function apiKey() {
  return process.env.API_FOOTBALL_KEY || null;
}

// Loose name match: normalize and check containment either direction so
// "Saudi Arabia" vs "Saudi-Arabia" / "Spain" vs "Spain U23" still align.
function _norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}
function _namesMatch(a, b) {
  const na = _norm(a), nb = _norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function _get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: HOST, path, headers: { 'x-apisports-key': apiKey() }, timeout: 10000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Verify a normalized WC match (from worldcup-provider) against API-Football.
// Returns one of:
//   { ok: true,  checked: false, reason }                  - couldn't check; fail-open
//   { ok: true,  checked: true,  second: '4-0' }           - scores AGREE
//   { ok: false, checked: true,  primary, second, fixture} - scores DISAGREE
async function verifyMatch(match, { logger = null } = {}) {
  const log = logger || console;
  if (!apiKey()) return { ok: true, checked: false, reason: 'API_FOOTBALL_KEY not set' };
  if (match.homeScore == null || match.awayScore == null) {
    return { ok: true, checked: false, reason: 'primary score incomplete' };
  }

  // Query fixtures on the match date (UTC) and find the one whose teams match.
  const date = new Date(match.utcDate || Date.now()).toISOString().slice(0, 10);
  let json;
  try {
    json = await _get(`/fixtures?date=${date}`);
  } catch (e) {
    log.warn(`Score cross-check lookup failed: ${e.message}`);
    return { ok: true, checked: false, reason: e.message };
  }

  const rows = (json && json.response) || [];
  const hit = rows.find((r) => {
    const h = r.teams?.home?.name, a = r.teams?.away?.name;
    return (
      (_namesMatch(h, match.homeTeam) && _namesMatch(a, match.awayTeam)) ||
      // tolerate home/away orientation differing between providers
      (_namesMatch(h, match.awayTeam) && _namesMatch(a, match.homeTeam))
    );
  });

  if (!hit) {
    return { ok: true, checked: false, reason: `no API-Football fixture found for ${match.homeTeam} v ${match.awayTeam} on ${date}` };
  }

  // Only trust a finished fixture as authoritative for a full-time comparison.
  const status = hit.fixture?.status?.short; // FT, AET, PEN, etc.
  if (!['FT', 'AET', 'PEN'].includes(status)) {
    return { ok: true, checked: false, reason: `API-Football fixture not finished (status=${status})` };
  }

  // Align goals to OUR home/away orientation.
  let sh = hit.goals?.home, sa = hit.goals?.away;
  if (_namesMatch(hit.teams?.home?.name, match.awayTeam) && !_namesMatch(hit.teams?.home?.name, match.homeTeam)) {
    [sh, sa] = [sa, sh]; // provider had teams flipped relative to us
  }
  if (sh == null || sa == null) {
    return { ok: true, checked: false, reason: 'API-Football goals incomplete' };
  }

  const primary = `${match.homeScore}-${match.awayScore}`;
  const second = `${sh}-${sa}`;
  if (Number(sh) === Number(match.homeScore) && Number(sa) === Number(match.awayScore)) {
    return { ok: true, checked: true, second };
  }
  return {
    ok: false, checked: true, primary, second,
    fixture: `${match.homeTeam} v ${match.awayTeam}`,
  };
}

module.exports = { verifyMatch };
