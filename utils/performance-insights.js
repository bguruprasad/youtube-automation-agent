// Performance insights: learn which football entities (players/teams) are
// actually driving views on THIS channel, so future Shorts can lean into
// proven winners instead of random curated picks.
//
// Signal source: AnalyticsOptimizationAgent.getUploadedVideosReport() — the
// marker-based per-video report (views/likes/comments per uploaded video). We
// only use entities we can extract from a video's TITLE (reliable) and credit
// each with that video's view count. The result is a ranked, weighted bias
// list consumed by football-moments-provider.
//
// Design choices:
//   - Shorts-first: this channel's wins are Shorts (per the strategy review),
//     so we rank on Shorts by default but fall back to all kinds if too few.
//   - Robust to no API / no data: returns an empty bias (callers stay random).
//   - We reuse a small entity dictionary mirrored from shorts-producer so the
//     two agree on canonical names (extend both together).

const fs = require('fs');
const path = require('path');

// Canonical entity dictionary: [matchSubstring(lowercase), CanonicalName].
// Mirrors ShortsProducer._extractEntities — keep in sync when extending.
const PLAYERS = [
  ['messi', 'Messi'], ['ronaldo', 'Ronaldo'], ['cristiano', 'Ronaldo'],
  ['mbappe', 'Mbappe'], ['mbappé', 'Mbappe'], ['haaland', 'Haaland'],
  ['neymar', 'Neymar'], ['iniesta', 'Iniesta'], ['zidane', 'Zidane'],
  ['benzema', 'Benzema'], ['salah', 'Salah'], ['kane', 'Kane'],
  ['bellingham', 'Bellingham'], ['vinicius', 'Vinicius'], ['modric', 'Modric'],
  ['suarez', 'Suarez'], ['lewandowski', 'Lewandowski'], ['havertz', 'Havertz'],
  ['maradona', 'Maradona'], ['ronaldinho', 'Ronaldinho'], ['beckham', 'Beckham'],
  ['gerrard', 'Gerrard'], ['aguero', 'Aguero'], ['roberto carlos', 'RobertoCarlos'],
];
const TEAMS = [
  ['spain', 'Spain'], ['france', 'France'], ['england', 'England'],
  ['brazil', 'Brazil'], ['argentina', 'Argentina'], ['germany', 'Germany'],
  ['portugal', 'Portugal'], ['netherlands', 'Netherlands'], ['italy', 'Italy'],
  ['croatia', 'Croatia'], ['belgium', 'Belgium'], ['liverpool', 'Liverpool'],
  ['barcelona', 'Barcelona'], ['real madrid', 'RealMadrid'], ['atletico', 'Atletico'],
  ['senegal', 'Senegal'], ['leicester', 'Leicester'], ['man city', 'ManCity'],
  ['manchester city', 'ManCity'],
];

function extractEntities(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const players = [], teams = [];
  for (const [kw, name] of PLAYERS) if (t.includes(` ${kw}`)) players.push(name);
  for (const [kw, name] of TEAMS) if (t.includes(kw)) teams.push(name);
  return { players: [...new Set(players)], teams: [...new Set(teams)] };
}

// Rank entities by the total views of the videos they appear in. Returns
// { players:[{name,views,videos}], teams:[...], basedOn, generatedAt }.
// `videos` = report.videos from getUploadedVideosReport(). `kindFilter` limits
// to one kind (e.g. 'short'); we fall back to all kinds if too few have stats.
function rankEntities(videos, { kindFilter = 'short', minVideos = 4 } = {}) {
  const withStats = (videos || []).filter(v => v.stats && (v.stats.views || 0) >= 0);
  let pool = kindFilter ? withStats.filter(v => v.kind === kindFilter) : withStats;
  let basedOn = kindFilter || 'all';
  if (pool.length < minVideos) { pool = withStats; basedOn = 'all'; } // not enough Shorts data yet

  const tally = (bucket) => {
    const map = new Map(); // name -> { views, videos }
    for (const v of pool) {
      const views = v.stats.views || 0;
      const ents = extractEntities(v.title || v.folder)[bucket];
      for (const name of ents) {
        const cur = map.get(name) || { views: 0, videos: 0 };
        cur.views += views; cur.videos += 1;
        map.set(name, cur);
      }
    }
    return [...map.entries()]
      .map(([name, s]) => ({ name, views: s.views, videos: s.videos }))
      .sort((a, b) => b.views - a.views);
  };

  return {
    players: tally('players'),
    teams: tally('teams'),
    basedOn,
    sampleSize: pool.length,
    generatedAt: new Date().toISOString(),
  };
}

const SNAPSHOT_PATH = () => path.join(__dirname, '..', 'data', 'winning-entities.json');

// Compute and persist the winning-entities snapshot from live report data.
// Returns the snapshot (or an empty one if there's no usable data).
async function refreshWinningEntities({ analytics, logger = null } = {}) {
  const empty = { players: [], teams: [], basedOn: 'none', sampleSize: 0, generatedAt: new Date().toISOString() };
  try {
    if (!analytics || typeof analytics.getUploadedVideosReport !== 'function') return empty;
    const report = await analytics.getUploadedVideosReport();
    if (!report.totalVideos) return empty;
    const ranked = rankEntities(report.videos);
    try { fs.writeFileSync(SNAPSHOT_PATH(), JSON.stringify(ranked, null, 2)); } catch (e) {
      if (logger) logger.warn(`Could not persist winning-entities snapshot: ${e.message}`);
    }
    if (logger) {
      const top = [...ranked.players, ...ranked.teams].sort((a, b) => b.views - a.views).slice(0, 5);
      logger.info(`Winning entities (${ranked.basedOn}, n=${ranked.sampleSize}): ` +
        (top.map(e => `${e.name}(${e.views}v)`).join(', ') || 'none'));
    }
    return ranked;
  } catch (e) {
    if (logger) logger.warn(`refreshWinningEntities failed: ${e.message}`);
    return empty;
  }
}

// Read the last persisted snapshot (no recompute). Cheap; used at selection time.
function loadWinningEntities() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH(), 'utf8')); }
  catch { return { players: [], teams: [], basedOn: 'none', sampleSize: 0 }; }
}

// Flatten a snapshot into a single ranked list of {name, views} (players+teams),
// best-first. Used to bias moment selection. Returns [] when there's no signal.
function topWinners(snapshot, limit = 8) {
  const s = snapshot || loadWinningEntities();
  return [...(s.players || []), ...(s.teams || [])]
    .filter(e => e.views > 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

module.exports = {
  extractEntities,
  rankEntities,
  refreshWinningEntities,
  loadWinningEntities,
  topWinners,
  SNAPSHOT_PATH,
};
