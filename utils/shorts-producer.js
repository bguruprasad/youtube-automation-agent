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

  // Extract real football ENTITIES (players, teams) from the title/moment text so
  // tags & hashtags are things fans actually search — not generic junk. Returns
  // { players:[], teams:[], hashtags:[] }. Heuristic + a small curated list; the
  // LLM step adds more. Conservative: only confident matches.
  _extractEntities(text) {
    const t = ` ${(text || '').toLowerCase()} `;
    // Curated football entities (extend over time). Each: search term + hashtag.
    const PLAYERS = [
      ['messi', 'Messi'], ['ronaldo', 'Ronaldo'], ['cristiano', 'Ronaldo'],
      ['mbappe', 'Mbappe'], ['mbappé', 'Mbappe'], ['haaland', 'Haaland'],
      ['neymar', 'Neymar'], ['iniesta', 'Iniesta'], ['zidane', 'Zidane'],
      ['benzema', 'Benzema'], ['salah', 'Salah'], ['kane', 'Kane'],
      ['bellingham', 'Bellingham'], ['vinicius', 'Vinicius'], ['modric', 'Modric'],
      ['suarez', 'Suarez'], ['lewandowski', 'Lewandowski'], ['havertz', 'Havertz'],
    ];
    const TEAMS = [
      ['spain', 'Spain'], ['france', 'France'], ['england', 'England'],
      ['brazil', 'Brazil'], ['argentina', 'Argentina'], ['germany', 'Germany'],
      ['portugal', 'Portugal'], ['netherlands', 'Netherlands'], ['italy', 'Italy'],
      ['croatia', 'Croatia'], ['belgium', 'Belgium'], ['liverpool', 'Liverpool'],
      ['barcelona', 'Barcelona'], ['real madrid', 'RealMadrid'], ['atletico', 'Atletico'],
    ];
    const players = [], teams = [];
    for (const [kw, name] of PLAYERS) if (t.includes(` ${kw}`)) players.push(name);
    for (const [kw, name] of TEAMS) if (t.includes(kw)) teams.push(name);
    return {
      players: [...new Set(players)],
      teams: [...new Set(teams)],
    };
  }

  // Ask the LLM for a SCROLL-STOPPING title + a tight 1-2 line hook description.
  // Shorts live or die on the title hook; this is a cheap gpt-4o-mini call.
  // Returns { title, description } or null on failure (caller falls back).
  async _llmShortTitleDesc(script, entities) {
    const openai = this.gen && this.gen.openai;
    if (!openai) return null;
    const subject = script.title || (script.hook && script.hook.text) || 'football moment';
    const ents = [...entities.players, ...entities.teams].join(', ');
    const sys = 'You write YouTube SHORTS metadata for a football (soccer) highlights channel. ' +
      'Goal: maximize click-through and watch time. Be punchy, emotional, curiosity-driven. ' +
      'NEVER use "tutorial", "how to", "for beginners", "top 10", "countdown", or listicle phrasing. ' +
      'Sound like an excited football fan, factual, no invented stats.';
    const user = `Football moment: "${subject}".${ents ? ` Featuring: ${ents}.` : ''}\n` +
      `Return STRICT JSON: {"title": "...", "description": "..."}\n` +
      `- title: <= 70 chars, a scroll-stopping hook (a curiosity gap or bold claim), may use ONE emoji. No hashtags.\n` +
      `- description: 1-2 short sentences that hook the viewer and tease the moment. No timestamps, no "what you'll learn", no "like and subscribe" filler.`;
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.8,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      });
      if (this.gen.costMeter) this.gen.costMeter.recordLLM('gpt-4o-mini', resp.usage, { label: 'Short SEO' });
      const out = JSON.parse(resp.choices[0].message.content);
      if (out && out.title) return { title: String(out.title).slice(0, 100), description: String(out.description || '').trim() };
    } catch (e) {
      this.logger.warn(`Short SEO LLM failed (${e.message}); using fallback title/desc`);
    }
    return null;
  }

  // Build SEO for a Short, PURPOSE-BUILT for short-form football (not the long
  // video tutorial/list template, which produced junk like "how to X tutorial"
  // tags). Hooky LLM title + description, fan-searched hashtags, real entity tags.
  async buildShortSeo(script) {
    const baseText = `${script.title || ''} ${(script.hook && script.hook.text) || ''}`;
    const entities = this._extractEntities(baseText);

    // Title + description: LLM hook, with a safe fallback.
    const llm = await this._llmShortTitleDesc(script, entities);
    let title = (llm && llm.title) || script.title || 'Football Short';
    let hook = (llm && llm.description) || (script.hook && script.hook.text) || script.title || '';

    // Hashtags fans actually search. Lead with #Shorts (YouTube can truncate
    // content after a later hashtag block, so a leading line is reliable).
    const entHashtags = [...entities.players, ...entities.teams].map(e => `#${e}`);
    const hashtags = ['#Shorts', '#Football', '#Soccer', ...entHashtags, '#WorldCup', '#Goals']
      .filter((h, i, a) => a.indexOf(h) === i).slice(0, 10);

    const description = `${hashtags.join(' ')}\n\n${hook}`.trim();

    // Tags: REAL entities + football staples. No tutorial/list junk. <=15 tags,
    // each a clean searchable term.
    const tagSet = [];
    entities.players.forEach(p => tagSet.push(p, `${p} goals`, `${p} skills`));
    entities.teams.forEach(t => tagSet.push(t, `${t} football`));
    tagSet.push('football', 'soccer', 'football shorts', 'football skills',
      'soccer goals', 'world cup 2026', 'football highlights');
    const tags = [...new Set(tagSet.map(s => s.toLowerCase()))]
      .filter(s => s && s.length <= 30).slice(0, 15);

    return {
      title: title.slice(0, 100),
      description,
      tags,
      metadata: { category: 17, language: 'en' }, // 17 = Sports
    };
  }

  /**
   * Produce a Short. `images` = absolute paths to source images (1+).
   * Returns { folder, folderPath, videoPath }.
   */
  async produce(script, images, { sourceThumb = null, match = null, seo = null, useClips = false, clipMode = 'mix' } = {}) {
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
    // overlay for World Cup recap Shorts. `useClips` layers Pexels B-roll.
    const videoPath = path.join(folderPath, 'video.mp4');
    // hookText: bold first-frame hook overlay (Shorts retention). Opt-out via
    // SHORTS_HOOK_OVERLAY=false.
    const hookText = (process.env.SHORTS_HOOK_OVERLAY === 'false') ? null : (script.hookText || null);
    await this.gen.generateVideo(script, verticalImages, audioPath, videoPath,
      { width: W, height: H, match, useClips, clipMode, hookText });
    // Per-scene clip-vs-still source (set by the assembler) for the (i) panel.
    const clipMeta = (useClips && Array.isArray(this.gen._lastClipMeta)) ? this.gen._lastClipMeta : null;

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

    // 6. SEO + persist script.json (with seo embedded for the uploader). Prefer
    // a caller-provided SEO (e.g. clean match-recap SEO); else build the default.
    const finalSeo = seo || await this.buildShortSeo(script);
    const scriptOut = { ...script, seo: finalSeo, format: 'short' };

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
    // Stock-clips info for the dashboard (i) panel: counts + per-scene source.
    if (useClips && clipMeta) {
      const clipCount = clipMeta.filter(s => s.type === 'clip').length;
      const cardCount = clipMeta.filter(s => s.type === 'card').length;
      scriptOut.meta.stockClips = {
        mode: clipMode,
        clipCount,
        cardCount,
        stillCount: clipMeta.length - clipCount - cardCount,
        scenes: clipMeta, // [{ type, query }]
      };
    }
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
