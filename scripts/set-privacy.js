// One-off: set privacy status of already-uploaded YouTube videos.
// Usage: node scripts/set-privacy.js private VIDEO_ID [VIDEO_ID...]
require('dotenv').config();
const { CredentialManager } = require('../utils/credential-manager');

(async () => {
  const status = process.argv[2];
  const ids = process.argv.slice(3);
  if (!['private', 'unlisted', 'public'].includes(status) || !ids.length) {
    console.error('Usage: node scripts/set-privacy.js <private|unlisted|public> <videoId...>');
    process.exit(1);
  }
  const cm = new CredentialManager();
  await cm.initialize();
  const yt = cm.getYouTubeClient();

  for (const id of ids) {
    try {
      const cur = await yt.videos.list({ part: 'status,snippet', id });
      const v = cur.data.items?.[0];
      if (!v) { console.error(`${id}: not found`); continue; }
      const before = v.status.privacyStatus;
      await yt.videos.update({
        part: 'status',
        requestBody: { id, status: { privacyStatus: status } },
      });
      console.log(`${id}: ${before} -> ${status}  ("${v.snippet.title}")`);
    } catch (e) {
      console.error(`${id}: FAILED ${e.message}`);
    }
  }
})();
