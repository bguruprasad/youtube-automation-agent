// One-off: remake the Spain vs Saudi Arabia recap Short with the CORRECT score
// (4-0; the primary feed wrongly reported 5-0 and we published it). Generates a
// Short only, uploads it unlisted for review, and writes match.json. Does not
// touch the old (already-private) wrong videos — clean those up separately.
require('dotenv').config();
const { YouTubeAutomationAgent } = require('../index.js');

(async () => {
  const agent = new YouTubeAutomationAgent();
  const ok = await agent.initialize();
  if (!ok) { console.error('Agent init failed'); process.exit(1); }

  // Corrected normalized match (shape matches utils/worldcup-provider normalizeMatch).
  const match = {
    id: '537371-corrected',         // distinct id so it won't collide with the seen-guard'd original
    utcDate: '2026-06-21T16:00:00Z',
    stage: 'GROUP_STAGE',
    matchday: 1,
    status: 'FINISHED',
    homeTeam: 'Spain',
    awayTeam: 'Saudi Arabia',
    homeScore: 4,                   // CORRECTED (was 5)
    awayScore: 0,
    homeCrestUrl: 'https://crests.football-data.org/760.svg',
    awayCrestUrl: 'https://crests.football-data.org/saudi_arabia.svg',
    competition: 'FIFA World Cup',
  };

  console.log(`Generating corrected Short: ${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`);
  const result = await agent.generateMatchVideos(match, { formats: ['short'] });
  console.log('Generation result:', JSON.stringify(result));

  if (result.short?.folder) {
    const { shortsRoot } = require('../utils/paths');
    const path = require('path');
    const fp = path.join(shortsRoot(), result.short.folder);
    console.log(`Uploading (unlisted) from ${fp} ...`);
    try {
      const up = await agent.agents.publishing.uploadOutputFolder(fp, { privacyStatus: 'unlisted' });
      console.log('Upload result:', JSON.stringify(up));
    } catch (e) {
      console.error('Upload failed:', e.message);
    }
  } else {
    console.error('No short produced:', result.shortError);
  }

  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
