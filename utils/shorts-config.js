// Central configuration for YouTube Shorts generation (vertical 9:16).
// All values are env-overridable. Keep Shorts settings in one place so the
// rest of the pipeline just reads from here.

function parseSize(str, fallback) {
  const m = /^(\d+)x(\d+)$/.exec((str || '').trim());
  return m ? { width: +m[1], height: +m[2] } : fallback;
}

const resolution = parseSize(process.env.SHORTS_RESOLUTION, { width: 1080, height: 1920 });

module.exports = {
  // Final video frame (vertical).
  resolution,
  // gpt-image-1 image generation for Shorts (portrait, cheaper quality).
  imageSize: process.env.SHORTS_IMAGE_SIZE || '1024x1536', // portrait
  imageQuality: process.env.SHORTS_IMAGE_QUALITY || 'low',  // low|medium|high
  // Hard duration cap (YouTube Shorts eligibility). Keep <= 60 to be safe.
  maxDuration: parseInt(process.env.SHORTS_MAX_DURATION || '60', 10),
  // How many images a fresh single-moment Short uses.
  imageCount: parseInt(process.env.SHORTS_IMAGE_COUNT || '2', 10),
  // Output directory for Shorts (ABSOLUTE path). Derives from OUTPUT_DIR (or
  // SHORTS_OUTPUT_DIR override) via utils/paths so all output can live outside
  // the repo. Was previously the relative string 'output/shorts'.
  outputDir: require('./paths').shortsRoot(),
  // Optional: football-data.org key enables RECENT real-match moments.
  footballDataApiKey: process.env.FOOTBALL_DATA_API_KEY || null,

  // --- Stock video clips (Pexels) ---------------------------------------
  // EXPERIMENTAL: layer real generic football B-roll (no real players, so
  // copyright-safe) into Shorts instead of / alongside Flux stills. OFF by
  // default. The runtime default is also gated behind a DB setting
  // (`stock_clips_enabled`) and a per-run `useClips` override; this env var is
  // only the fallback default when neither is provided.
  stockClips: {
    // Default-on switch (env fallback only; DB setting / per-run override win).
    enabledDefault: String(process.env.STOCK_CLIPS || '').toLowerCase() === 'true',
    // 'mix'        -> some scenes are clips, some stay Flux stills.
    // 'background' -> one clip runs full-frame behind the overlays for the whole short.
    mode: (process.env.STOCK_CLIPS_MODE || 'mix').toLowerCase(),
    // Pexels API (free tier). No key => feature silently disabled (fails open).
    apiKey: process.env.PEXELS_API_KEY || null,
    // Minimum clip length (s) to accept from search (we trim/loop to scene length).
    minClipSec: parseInt(process.env.STOCK_CLIP_MIN_SEC || '4', 10),
  },
};
