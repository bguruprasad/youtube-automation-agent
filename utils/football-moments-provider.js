// Provides football "moments" for fresh Shorts. Two sources, merged:
//   1) CURATED  - iconic evergreen moments (always available, no dependency)
//   2) RECENT   - real recent matches via football-data.org (optional; only
//                 when FOOTBALL_DATA_API_KEY is set). Accurate because facts
//                 come from the API, not the LLM's (stale) memory.
// If no API key, gracefully returns curated-only.

const https = require('https');
const shortsConfig = require('./shorts-config');

// Iconic, evergreen single moments. Each is one Short's subject.
const CURATED_MOMENTS = [
  { title: "Maradona's Hand of God", hint: "1986 World Cup quarter-final vs England; the controversial handball goal." },
  { title: "Maradona's Goal of the Century", hint: "1986 vs England; solo run past five players." },
  { title: "Aguero's 93:20 Title Winner", hint: "Man City vs QPR 2012; last-gasp goal wins the Premier League." },
  { title: "The Miracle of Istanbul", hint: "2005 Champions League final; Liverpool come back from 3-0 down vs Milan." },
  { title: "Zidane's Headbutt", hint: "2006 World Cup final; Zidane sent off for headbutting Materazzi." },
  { title: "Iniesta's World Cup Winner", hint: "2010 final; Spain beat Netherlands in extra time." },
  { title: "Sergio Ramos' 93rd-Minute Equaliser", hint: "2014 Champions League final; Real Madrid force extra time vs Atletico." },
  { title: "Roberto Carlos' Impossible Free Kick", hint: "1997 vs France; the banana free kick that defied physics." },
  { title: "Gazza's Goal vs Scotland", hint: "Euro 96; the flick and volley." },
  { title: "Ronaldinho's No-Look Magic", hint: "Barcelona era; outrageous skill and assists." },
  { title: "Germany 7-1 Brazil", hint: "2014 World Cup semi-final; historic demolition." },
  { title: "Leicester City's Title Miracle", hint: "2015-16 Premier League; 5000-1 outsiders win the league." },
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else { reject(new Error(`HTTP ${res.statusCode}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Pull a recent finished match from football-data.org to seed a "recent moment".
// Returns a moment {title, hint, recent:true} or null on any failure.
async function getRecentMoment(logger) {
  const key = shortsConfig.footballDataApiKey;
  if (!key) return null;
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // last 10 days
    const fmt = (d) => d.toISOString().slice(0, 10);
    const url = `https://api.football-data.org/v4/matches?status=FINISHED&dateFrom=${fmt(from)}&dateTo=${fmt(to)}`;
    const data = await httpGetJson(url, { 'X-Auth-Token': key });
    const matches = (data.matches || []).filter(m => m.score && m.score.fullTime);
    if (!matches.length) return null;
    // Prefer matches with a decisive/high-scoring result (more "moment"-worthy).
    matches.sort((a, b) => {
      const g = (m) => (m.score.fullTime.home || 0) + (m.score.fullTime.away || 0);
      return g(b) - g(a);
    });
    const m = matches[0];
    const home = m.homeTeam?.shortName || m.homeTeam?.name || 'Home';
    const away = m.awayTeam?.shortName || m.awayTeam?.name || 'Away';
    const hs = m.score.fullTime.home, as = m.score.fullTime.away;
    const comp = m.competition?.name || 'football';
    return {
      title: `${home} ${hs}-${as} ${away}: The Standout Moment`,
      hint: `Recent ${comp} match (${m.utcDate?.slice(0,10)}): ${home} ${hs}-${as} ${away}. ` +
            `Focus on the single most dramatic moment of this game.`,
      recent: true,
    };
  } catch (e) {
    if (logger) logger.warn(`Recent-moment fetch failed, using curated: ${e.message}`);
    return null;
  }
}

// Main entry: returns one moment {title, hint, recent?}.
// `preferRecent` (default true) tries the API first when configured, then
// falls back to a curated moment.
async function getMoment({ preferRecent = true, logger = null } = {}) {
  if (preferRecent && shortsConfig.footballDataApiKey) {
    const recent = await getRecentMoment(logger);
    if (recent) return recent;
  }
  return { ...pickRandom(CURATED_MOMENTS), recent: false };
}

module.exports = { getMoment, getRecentMoment, CURATED_MOMENTS };
