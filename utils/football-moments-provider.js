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

// Suggest several Short ideas up-front so the user can see what the AI intends
// to make and pick which ones to actually produce (mirrors long-video topic
// suggestions). Each suggestion = { title, hint, angle, hook, recent }.
//   - title : the Short's subject (also the `moment` passed to /generate-short)
//   - hint  : factual context that seeds the script + visuals
//   - angle : 1-line "why this works" (the AI's reasoning, shown in the card)
//   - hook  : the opening line the Short would likely lead with
// Uses OpenAI when an `openai` client is provided; otherwise falls back to a
// random sample of curated moments (with generic angle/hook).
async function suggestMoments({ count = 3, openai = null, logger = null } = {}) {
  count = Math.max(1, Math.min(5, parseInt(count) || 3));

  // Curated fallback: sample distinct moments, synthesize angle/hook.
  const curatedFallback = () => {
    const pool = [...CURATED_MOMENTS];
    const out = [];
    while (out.length < count && pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      const m = pool.splice(idx, 1)[0];
      out.push({
        title: m.title,
        hint: m.hint,
        angle: 'Iconic, evergreen moment with built-in search demand.',
        hook: `This is the story of ${m.title}.`,
        recent: false,
      });
    }
    return out;
  };

  if (!openai) return curatedFallback();

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a YouTube Shorts strategist for a football/soccer channel. ` +
            `Propose single-moment Short ideas (one dramatic moment each, <=60s vertical). ` +
            `Return ONLY a JSON array of objects with keys: ` +
            `title (the moment, e.g. "Maradona's Hand of God"), ` +
            `hint (1-2 sentences of factual context to seed the script), ` +
            `angle (1 sentence on why this Short would perform well), ` +
            `hook (the punchy opening line the Short should start with). No markdown.`,
        },
        {
          role: 'user',
          content: `Suggest ${count} football Short ideas worth making right now. ` +
            `Favor dramatic, instantly-recognizable moments with strong visual potential. ` +
            `Keep facts accurate; do not invent scorelines.`,
        },
      ],
      temperature: 0.9,
      max_tokens: 900,
    });
    const content = response.choices[0].message.content.trim();
    const jsonStr = content.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const ideas = JSON.parse(jsonStr);
    return ideas.slice(0, count).map((i) => ({
      title: i.title || 'Untitled moment',
      hint: i.hint || '',
      angle: i.angle || '',
      hook: i.hook || '',
      recent: false,
    }));
  } catch (e) {
    if (logger) logger.warn(`Short-idea suggestion failed, using curated: ${e.message}`);
    return curatedFallback();
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

module.exports = { getMoment, getRecentMoment, suggestMoments, CURATED_MOMENTS };
