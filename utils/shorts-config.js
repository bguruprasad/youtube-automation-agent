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
};
