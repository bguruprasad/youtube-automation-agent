// ShortsProducer: assembles a vertical 9:16 YouTube Short from a short-form
// script + images. Shared by both modes:
//   - Mode A (fresh): images are freshly generated portrait images
//   - Mode B (repurpose): images come from an existing long-video folder
// Produces output/shorts/<slug>/ with video.mp4 (1080x1920), narration.mp3,
// captions.srt, thumbnail.png, script.json - the same layout the uploader
// already understands.

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { execSync } = require('child_process');
const shortsConfig = require('./shorts-config');

class ShortsProducer {
  constructor(aiVideoGenerator, logger) {
    this.gen = aiVideoGenerator; // AIVideoGenerator instance (TTS, images, assembly)
    this.logger = logger || console;
    this.sharp = (() => { try { return require('sharp'); } catch { return null; } })();
  }

  slugify(title) {
    return (title || 'short').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }

  // Fit an image to vertical 1080x1920. Landscape sources would letterbox, so
  // we build a blurred, scaled-up copy as the background and overlay the
  // contained image on top - edge-to-edge, no black bars.
  async fitImageToVertical(srcPath, destPath, W, H) {
    if (!this.sharp) { await fs.copyFile(srcPath, destPath); return destPath; }
    try {
      const meta = await this.sharp(srcPath).metadata();
      const isPortraitEnough = (meta.height || 0) >= (meta.width || 1) * 1.2;
      if (isPortraitEnough) {
        // Already tall - just cover-crop to exact frame.
        await this.sharp(srcPath).resize(W, H, { fit: 'cover' }).png().toFile(destPath);
        return destPath;
      }
      // Blurred background (cover) + contained foreground.
      const bg = await this.sharp(srcPath).resize(W, H, { fit: 'cover' }).blur(40)
        .modulate({ brightness: 0.6 }).toBuffer();
      const fg = await this.sharp(srcPath).resize(W, Math.round(H * 0.62), { fit: 'inside' }).toBuffer();
      const fgMeta = await this.sharp(fg).metadata();
      await this.sharp(bg)
        .composite([{ input: fg, top: Math.round((H - (fgMeta.height || 0)) / 2), left: Math.round((W - (fgMeta.width || 0)) / 2) }])
        .png().toFile(destPath);
      return destPath;
    } catch (e) {
      this.logger.warn(`fitImageToVertical failed (${e.message}); copying as-is`);
      await fs.copyFile(srcPath, destPath); return destPath;
    }
  }

  // Plain narration text for a short (hook + content, no "Section N:" prefixes).
  shortTtsText(script) {
    const parts = [];
    if (script.hook && script.hook.text) parts.push(script.hook.text);
    (script.mainContent?.sections || []).forEach(s => {
      const c = Array.isArray(s.content) ? s.content.join(' ') : s.content;
      if (c) parts.push(c);
    });
    if (script.callToAction && script.callToAction.subscribe) parts.push(script.callToAction.subscribe);
    return parts.join(' ');
  }

  // Build SEO for a short: reuse the SEO agent's description/tags, append #Shorts.
  async buildShortSeo(script) {
    const strategy = (script.metadata && script.metadata.strategy) || {
      topic: script.title, angle: '', keywords: script.keywords || [],
      targetAudience: 'football fans', contentType: 'List'
    };
    let description = (script.hook && script.hook.text) || script.title;
    let tags = script.keywords || [];
    try {
      const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');
      const seo = Object.create(SEOOptimizerAgent.prototype);
      description = await seo.generateDescription(script, strategy);
      tags = await seo.generateTags(script, strategy);
    } catch (e) {
      this.logger.warn(`Short SEO fell back to minimal: ${e.message}`);
    }
    // Shorts need #Shorts to be classified. Put it at the TOP: YouTube can
    // truncate content after a later hashtag block, so a trailing #Shorts may
    // be dropped. A leading hashtag line is reliable and still valid.
    description = `#Shorts #Football #Soccer\n\n` + description.replace(/\n*#Shorts[^\n]*/gi, '').trim();
    return {
      title: (script.title || 'Football Short').slice(0, 100),
      description,
      tags: Array.isArray(tags) ? tags.slice(0, 30) : [],
      metadata: { category: 17, language: 'en' } // 17 = Sports
    };
  }

  /**
   * Produce a Short. `images` = absolute paths to source images (1+).
   * Returns { folder, folderPath, videoPath }.
   */
  async produce(script, images, { sourceThumb = null, match = null } = {}) {
    const W = shortsConfig.resolution.width;
    const H = shortsConfig.resolution.height;
    const { folderTimestamp } = require('./timestamp');
    const slug = this.slugify(script.title);
    const folder = `${folderTimestamp()}_${slug}`;
    const folderPath = path.resolve(shortsConfig.outputDir, folder);
    const assetsDir = path.join(folderPath, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });

    // 1. Fit images to vertical (blur-fill landscape sources).
    const verticalImages = [];
    for (let i = 0; i < images.length; i++) {
      const dest = path.join(assetsDir, `visual_${i + 1}.png`);
      await this.fitImageToVertical(images[i], dest, W, H);
      verticalImages.push(dest);
    }

    // 2. Narration (TTS) - cap at the short's duration.
    const ttsText = this.shortTtsText(script);
    await fs.writeFile(path.join(folderPath, 'script_tts.txt'), ttsText);
    const narrationPath = path.join(folderPath, 'narration.mp3');
    let audioPath = null;
    try {
      await this.gen.generateTTSAudio(ttsText, narrationPath);
      audioPath = narrationPath;
    } catch (e) {
      this.logger.warn(`Short TTS failed (${e.message}); building silent short`);
    }

    // 3. Assemble vertical video. `match` (optional) enables the scoreboard
    // overlay for World Cup recap Shorts.
    const videoPath = path.join(folderPath, 'video.mp4');
    await this.gen.generateVideo(script, verticalImages, audioPath, videoPath, { width: W, height: H, match });

    // 4. Captions (simple, from narration text & duration).
    try {
      await this._writeSrt(script, path.join(folderPath, 'captions.srt'));
    } catch (e) { this.logger.warn(`Short captions failed: ${e.message}`); }

    // 5. Thumbnail: reuse a vertical frame (or a source thumb fitted to portrait).
    try {
      const thumbDest = path.join(folderPath, 'thumbnail.png');
      if (sourceThumb && fsSync.existsSync(sourceThumb)) {
        await this.fitImageToVertical(sourceThumb, thumbDest, W, H);
      } else if (verticalImages[0]) {
        await fs.copyFile(verticalImages[0], thumbDest);
      }
    } catch (e) { this.logger.warn(`Short thumbnail failed: ${e.message}`); }

    // 6. SEO + persist script.json (with seo embedded for the uploader).
    const seo = await this.buildShortSeo(script);
    const scriptOut = { ...script, seo, format: 'short' };

    // Generation cost + metadata for the dashboard (i) info panel. The meter is
    // attached to the shared AIVideoGenerator by the /generate-short flow, so it
    // already holds the scene-image charges generated there plus this TTS run.
    if (this.gen.costMeter) scriptOut.cost = this.gen.costMeter.summary();
    scriptOut.meta = {
      type: 'short',
      resolution: `${W}x${H}`,
      durationSec: Math.min(script.duration || 50, shortsConfig.maxDuration),
      imageCount: images.length,
      models: { image: 'gpt-image-1', tts: this.gen.elevenLabsApiKey ? 'elevenlabs' : 'tts-1-hd' },
      generatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(folderPath, 'script.json'), JSON.stringify(scriptOut, null, 2));

    this.logger.info(`Short produced: ${folderPath}`);
    return { folder, folderPath, videoPath };
  }

  async _writeSrt(script, srtPath) {
    const fmt = (s) => {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.floor((s % 1) * 1000);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
    };
    const text = this.shortTtsText(script);
    const dur = Math.min(script.duration || 50, shortsConfig.maxDuration);
    const words = text.split(/\s+/).filter(Boolean);
    const per = 6; let srt = ''; let idx = 1;
    const chunks = Math.ceil(words.length / per);
    for (let i = 0; i < words.length; i += per) {
      const start = (i / words.length) * dur;
      const end = Math.min(((i + per) / words.length) * dur, dur);
      srt += `${idx++}\n${fmt(start)} --> ${fmt(end)}\n${words.slice(i, i + per).join(' ')}\n\n`;
    }
    await fs.writeFile(srtPath, srt);
  }
}

module.exports = { ShortsProducer };
