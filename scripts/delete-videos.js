// One-off: permanently DELETE uploaded YouTube videos. Irreversible.
// Usage: node scripts/delete-videos.js VIDEO_ID [VIDEO_ID...]
require('dotenv').config();
const { CredentialManager } = require('../utils/credential-manager');

(async () => {
  const ids = process.argv.slice(2);
  if (!ids.length) {
    console.error('Usage: node scripts/delete-videos.js <videoId...>');
    process.exit(1);
  }
  const cm = new CredentialManager();
  await cm.initialize();
  const yt = cm.getYouTubeClient();

  for (const id of ids) {
    try {
      // Show what we're about to delete (title) for the log trail.
      let title = '(unknown)';
      try {
        const cur = await yt.videos.list({ part: 'snippet', id });
        title = cur.data.items?.[0]?.snippet?.title || '(not found)';
      } catch {}
      await yt.videos.delete({ id });
      console.log(`${id}: DELETED  ("${title}")`);
    } catch (e) {
      console.error(`${id}: FAILED ${e.message}`);
    }
  }
})();
