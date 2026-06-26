const OpenAI = require('openai');
const Replicate = require('replicate');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { Logger } = require('./logger');

// Optional sharp import - falls back to raw AI image without text overlay
let sharp;
try {
  sharp = require('sharp');
} catch {
  // sharp not available; text overlay on thumbnails will be skipped
}

const execAsync = promisify(exec);

class AIVideoGenerator {
  constructor(credentials) {
    this.logger = new Logger('AIVideoGenerator');

    // Optional per-run cost meter. Callers set `this.costMeter = new CostMeter()`
    // before a run and read `.summary()` after. Null = metering disabled (no-op).
    this.costMeter = null;

    // Initialize AI services with graceful fallback
    const openaiKey = credentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = credentials.replicate?.apiKey || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = credentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = credentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    
    // Azure Speech configuration
    this.azureSpeechKey = credentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = credentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
  }

  // Retry an async OpenAI call with exponential backoff on transient errors
  // (429 rate-limit / quota, 5xx). gpt-image-1 frequently 429s; without this the
  // caller silently falls back to a placeholder image, which then breaks video
  // assembly. Honors a Retry-After header when present.
  async _withRetry(fn, { tries = 4, baseDelayMs = 2000, label = 'OpenAI call' } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const status = err?.status || err?.response?.status;
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (!retryable || attempt === tries) throw err;
        const retryAfter = Number(err?.headers?.['retry-after'] || err?.response?.headers?.['retry-after']);
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseDelayMs * 2 ** (attempt - 1);
        this.logger.warn(`${label} failed (${status || err.message}); retry ${attempt}/${tries - 1} in ${Math.round(delay / 1000)}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');
    
    try {
      // Try ElevenLabs first (higher quality)
      if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
        return await this.generateElevenLabsTTS(text, outputPath);
      }
      
      // Fallback to OpenAI TTS
      if (this.openai) {
        return await this.generateOpenAITTS(text, outputPath);
      }
      
      // Final fallback to simulation
      return await this.simulateTTSGeneration(text, outputPath);
    } catch (error) {
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    if (this.costMeter) this.costMeter.recordElevenLabsTTS(text.length);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  // Split text into chunks at sentence boundaries, respecting maxLen
  chunkText(text, maxLen = 4096) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Find last sentence boundary within maxLen
      let cut = remaining.lastIndexOf('. ', maxLen);
      if (cut === -1 || cut < maxLen * 0.3) cut = remaining.lastIndexOf(' ', maxLen);
      if (cut === -1) cut = maxLen;
      else cut += 1; // include the space/period
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    return chunks;
  }

  async generateOpenAITTS(text, outputPath) {
    const chunks = this.chunkText(text, 4096);
    this.logger.info(`TTS: processing ${chunks.length} chunk(s) (${text.length} chars total)`);
    if (this.costMeter) this.costMeter.recordOpenAITTS(text.length, 'tts-1-hd');

    if (chunks.length === 1) {
      const response = await this.openai.audio.speech.create({
        model: "tts-1-hd",
        voice: "nova",
        input: chunks[0],
        speed: 1.0
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(outputPath, buffer);
    } else {
      // Generate each chunk, then concatenate with ffmpeg
      const chunkPaths = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = outputPath.replace(/(\.\w+)$/, `_chunk${i}$1`);
        const response = await this.openai.audio.speech.create({
          model: "tts-1-hd",
          voice: "nova",
          input: chunks[i],
          speed: 1.0
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(chunkPath, buffer);
        chunkPaths.push(chunkPath);
      }

      // Concatenate with ffmpeg
      const listFile = outputPath.replace(/(\.\w+)$/, '_list.txt');
      const listContent = chunkPaths.map(p => `file '${p}'`).join('\n');
      await fs.writeFile(listFile, listContent);

      const { execSync } = require('child_process');
      execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`, { stdio: 'pipe' });

      // Cleanup temp files
      for (const p of chunkPaths) { try { await fs.unlink(p); } catch {} }
      try { await fs.unlink(listFile); } catch {}
    }

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1, imageOpts = {}) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      if (!this.openai && !(this._imageProvider() === 'flux' && this.replicate)) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      // Alternative provider: Flux 1.1 Pro via Replicate (better photorealism +
      // legible jersey text than gpt-image-1). Gated on IMAGE_PROVIDER=flux and a
      // Replicate key. Falls back to gpt-image-1 below if Flux errors.
      if (this._imageProvider() === 'flux' && this.replicate) {
        try {
          return await this._generateFluxAssets(prompt, style, imageOpts);
        } catch (e) {
          this.logger.warn(`Flux generation failed (${e.message}); falling back to gpt-image-1`);
          if (!this.openai) return await this.simulateVisualAssets(prompt, style, count);
        }
      }

      // Size/quality are overridable (Shorts use portrait + lower quality).
      const baseParams = {
        model: "gpt-image-1",
        n: 1,
        size: imageOpts.size || "1536x1024", // default landscape for video
        quality: imageOpts.quality || "medium"
      };
      const params = { ...baseParams, prompt: this.enhanceVisualPrompt(prompt, style) };

      let response;
      try {
        response = await this._withRetry(
          () => this.openai.images.generate(params),
          { label: 'Scene image generation' }
        );
      } catch (err) {
        // gpt-image-1's safety system sometimes rejects an otherwise-innocuous
        // prompt (400). Retrying the same prompt won't help, but a neutral,
        // de-stylized version (no possessives/marketing words, no named person)
        // usually passes — better a generic football image than a placeholder.
        const status = err?.status || err?.response?.status;
        const isSafety = status === 400 && /safety/i.test(err?.message || '');
        if (!isSafety) throw err;
        const safePrompt = this._safeFallbackPrompt(prompt);
        this.logger.warn(`Image prompt rejected by safety system; retrying with neutral prompt: "${safePrompt}"`);
        response = await this._withRetry(
          () => this.openai.images.generate({ ...baseParams, prompt: safePrompt }),
          { label: 'Scene image generation (safe retry)' }
        );
      }
      if (this.costMeter) {
        this.costMeter.recordImage(params.size, params.quality, { count: response.data.length, label: 'Scene image' });
      }

      const localPaths = [];

      // Save images locally (handle both url and b64_json responses)
      for (let i = 0; i < response.data.length; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await fs.mkdir(path.dirname(imagePath), { recursive: true });
        const img = response.data[i];
        if (img.b64_json) {
          await fs.writeFile(imagePath, Buffer.from(img.b64_json, 'base64'));
        } else if (img.url) {
          await this.downloadImage(img.url, imagePath);
        }
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  // Which image provider to use: 'flux' (Replicate) or 'openai' (gpt-image-1).
  // Defaults to openai. Set IMAGE_PROVIDER=flux to A/B the alternative.
  _imageProvider() {
    return (process.env.IMAGE_PROVIDER || 'openai').toLowerCase();
  }

  // Map a requested pixel size (e.g. "1024x1536" / "1536x1024") to the nearest
  // Flux aspect_ratio token. Flux takes aspect_ratio, not arbitrary W×H.
  _fluxAspectRatio(size) {
    const m = /^(\d+)x(\d+)$/.exec(size || '');
    if (!m) return '16:9';
    const w = +m[1], h = +m[2];
    return h > w ? '9:16' : (w > h ? '16:9' : '1:1');
  }

  // Resolve the Flux output megapixels for this generation, honouring (in order):
  // an explicit opts.megapixels, the per-format env (FLUX_MEGAPIXELS_SHORT /
  // FLUX_MEGAPIXELS_LONG via opts.format), the global FLUX_MEGAPIXELS, then 1.
  // Lets Shorts and longs be tuned independently later without code changes.
  _fluxMegapixels(opts = {}) {
    if (opts.megapixels) return String(opts.megapixels);
    const fmt = opts.format === 'short' ? 'SHORT' : opts.format === 'long' ? 'LONG' : null;
    if (fmt && process.env[`FLUX_MEGAPIXELS_${fmt}`]) return process.env[`FLUX_MEGAPIXELS_${fmt}`];
    return process.env.FLUX_MEGAPIXELS || '1';
  }

  // Generate scene images via Flux on Replicate (default flux-2-pro). Returns
  // saved PNG paths (same contract as the gpt-image-1 path). Throws on failure
  // so the caller can fall back.
  //
  // Pricing (flux-2-pro): $0.015 per run + $0.015 per OUTPUT megapixel (no input
  // image, so no input-MP charge). Cost is metered as base + MP×rate.
  async _generateFluxAssets(prompt, style, imageOpts = {}) {
    const model = process.env.FLUX_MODEL || 'black-forest-labs/flux-2-pro';
    const aspect = this._fluxAspectRatio(imageOpts.size);
    const megapixels = this._fluxMegapixels(imageOpts);
    const fullPrompt = this.enhanceVisualPrompt(prompt, style);

    // Flux occasionally renders a multi-panel COLLAGE/montage despite the prompt.
    // Generate, then detect collage seams; if found, retry (each attempt is a
    // fresh seed). Cap attempts so a persistent case still returns the last image.
    const maxAttempts = Math.max(1, parseInt(process.env.FLUX_COLLAGE_RETRIES || '2') + 1);
    let imagePath = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.logger.info(`Generating visual asset via Flux (${model}, ${aspect}, ${megapixels}MP) attempt ${attempt}/${maxAttempts}`);
      imagePath = await this._fluxGenerateOnce(fullPrompt, aspect, megapixels);

      // Meter every billed attempt (a discarded collage still costs).
      if (this.costMeter) {
        const base = parseFloat(process.env.FLUX_RUN_RATE || '0.015');
        const perMp = parseFloat(process.env.FLUX_MP_RATE || '0.015');
        const mp = parseFloat(megapixels) || 1;
        this.costMeter.recordFlatImage(base + perMp * mp, {
          label: 'Scene image (Flux)', detail: `${aspect} ${mp}MP ${model}${attempt > 1 ? ' (retry)' : ''}` });
      }

      const collage = await this._looksLikeCollage(imagePath);
      if (!collage) { this.logger.info(`Generated 1 visual asset (Flux)`); return [imagePath]; }
      this.logger.warn(`Flux output looks like a collage (attempt ${attempt}); ${attempt < maxAttempts ? 'retrying' : 'keeping last (out of retries)'}`);
      if (attempt < maxAttempts) { try { await fs.unlink(imagePath); } catch {} }
    }
    return [imagePath];
  }

  // One Flux generation → saved PNG path. Throws on failure (caller falls back).
  async _fluxGenerateOnce(fullPrompt, aspect, megapixels) {
    const model = process.env.FLUX_MODEL || 'black-forest-labs/flux-2-pro';
    const output = await this.replicate.run(model, {
      input: {
        prompt: fullPrompt,
        aspect_ratio: aspect,
        megapixels,
        output_format: 'png',
        safety_tolerance: parseInt(process.env.FLUX_SAFETY_TOLERANCE || '1'),
        prompt_upsampling: process.env.FLUX_PROMPT_UPSAMPLING === 'true',
      },
    });
    let url = Array.isArray(output) ? output[0] : output;
    if (url && typeof url.url === 'function') url = url.url();
    url = String(url);
    if (!/^https?:\/\//.test(url)) throw new Error(`Unexpected Flux output: ${url.slice(0, 80)}`);
    const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_0.png`);
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await this.downloadImage(url, imagePath);
    return imagePath;
  }

  // Heuristic collage detector: a panel collage has near-uniform, very-dark/flat
  // DIVIDER lines spanning the full width or height at interior positions (the
  // gutter between panels). We scan interior rows/columns for lines whose pixels
  // are almost all dark and low-variance; 1+ such full-span seam ⇒ collage.
  // Returns false on any error (fail-open: never block a generation on detection).
  async _looksLikeCollage(imagePath) {
    try {
      const sharp = require('sharp');
      const TARGET = 200; // downscale for a fast scan
      const { data, info } = await sharp(imagePath)
        .greyscale().resize(TARGET, TARGET, { fit: 'fill' })
        .raw().toBuffer({ resolveWithObject: true });
      const W = info.width, H = info.height;
      const at = (x, y) => data[y * W + x];

      // A "seam" line: >=90% of its pixels are dark (<40) AND the line is flat
      // (low spread). Only count interior lines (avoid the natural dark border).
      const isSeam = (vals) => {
        let dark = 0, min = 255, max = 0;
        for (const v of vals) { if (v < 40) dark++; if (v < min) min = v; if (v > max) max = v; }
        return dark / vals.length >= 0.9 && (max - min) <= 60;
      };
      const margin = Math.floor(0.12 * Math.max(W, H)); // ignore outer 12% (borders)
      let seams = 0;
      for (let y = margin; y < H - margin; y++) {
        const row = []; for (let x = 0; x < W; x++) row.push(at(x, y));
        if (isSeam(row)) { seams++; y += 3; } // skip a few px so one thick seam counts once
      }
      for (let x = margin; x < W - margin; x++) {
        const col = []; for (let y = 0; y < H; y++) col.push(at(x, y));
        if (isSeam(col)) { seams++; x += 3; }
      }
      return seams >= 1;
    } catch (e) {
      this.logger.warn(`Collage detection skipped: ${e.message}`);
      return false;
    }
  }

  // Build a neutral, safety-system-friendly image prompt from a rejected one:
  // drop possessives (named people) and hype/marketing words that can trip the
  // filter, and ask for a generic football scene. Used only after a 400 safety
  // rejection. Always returns a usable on-topic prompt.
  _safeFallbackPrompt(originalPrompt) {
    let p = String(originalPrompt || '')
      .replace(/\b[\w-]+'s\b/gi, '')                 // strip possessives ("Messi's")
      .replace(/\b(magic|sensation|nightmare|iconic|unforgettable|epic|stunning|legendary|miracle)\b/gi, '')
      .replace(/[:."]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Keep it short and generic; lead with a clearly-safe subject.
    return `A dramatic professional football (soccer) stadium scene, players in action on the pitch, ` +
      `cinematic lighting, crowd in the background. ${p ? 'Theme: ' + p + '.' : ''} ` +
      `No text, no watermarks, no real identifiable faces.`;
  }

  // Build a richer scene-image prompt for a football moment/match. Pulls in the
  // factual context (hint/narration) and the script's own visual direction so
  // the image reflects what's actually being narrated — team colours, opponent,
  // setting — instead of a generic stadium shot.
  //
  // PROVIDER-AWARE framing (IMAGE_PROVIDER):
  //  - flux  (flux-2-pro): renders real player likeness AND legible jersey text,
  //    so we prompt the player DIRECTLY with the face shown — best identity.
  //  - openai (gpt-image-1): garbles jersey text and can't do a real likeness,
  //    so we keep the face off-subject and suppress jersey text (identity comes
  //    from kit colour + action). Names also trip its safety filter.
  // Both: force teammates into ONE consistent kit colour (avoids mixed colours).
  //
  // opts: { hint, sceneDirection, teams:{home,away}, kits:{home,away} }
  //   kits.home/away are short colour descriptions, e.g. "red and white stripes".
  // The script's `visuals` field is written for VIDEO editing ("footage of X
  // scoring each goal, fan reactions, match highlights") — words that make an
  // image model render a multi-shot MONTAGE/collage. For a single still we strip
  // the montage-trigger language down to one concrete action.
  _singleShotDirection(sceneDirection) {
    let s = String(sceneDirection || '')
      .replace(/\b(footage|clips?|montage|highlights?|compilation|sequence|series of|various|multiple|several)\b/gi, '')
      .replace(/\b(each|every)\s+goal\b/gi, 'a goal')
      .replace(/\b(reactions?|moments?)\b/gi, '')
      .replace(/[,;].*$/, '')        // keep only the first clause (one action)
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  // Pool of photorealistic photographic styles for football scenes. One is
  // picked at random per image so the channel doesn't look samey (was always
  // "cinematic"). All stay believable as real football imagery — no cartoon/
  // illustration looks that would clash with real players. Each entry is a short
  // descriptor injected into the prompt. Pin one for testing via SCENE_STYLE.
  static SCENE_STYLES = {
    cinematic:        'cinematic film-still look, dramatic floodlights, high contrast, moody atmosphere, 35mm, shallow depth of field',
    broadcast:        'crisp live sports-broadcast look, bright even stadium lighting, telephoto lens compression, ultra-sharp, vivid green pitch',
    photojournalistic:'gritty press/photojournalism style, frozen split-second action, natural authentic light, fine photographic grain, Getty/AP sports-photo feel',
    goldenHour:       'warm golden-hour backlight, low sun, long shadows, glowing rim light, epic and emotive',
    desaturatedMoody: 'moody desaturated muted palette, deep shadows, single dramatic spotlight, high-contrast and atmospheric',
    vibrantAction:    'vivid saturated colours, vibrant and energetic, crisp high-clarity action, punchy dynamic feel',
    wideEpic:         'sweeping wide-angle, vast stadium scale, towering stands, atmospheric haze and light beams, epic sense of occasion',
  };

  // Pick a scene style key. SCENE_STYLE env pins one (for testing/A-B); otherwise
  // random per call.
  _pickSceneStyle() {
    const keys = Object.keys(AIVideoGenerator.SCENE_STYLES);
    const pinned = process.env.SCENE_STYLE;
    if (pinned && AIVideoGenerator.SCENE_STYLES[pinned]) return pinned;
    return keys[Math.floor(Math.random() * keys.length)];
  }

  buildSceneImagePrompt(subject, opts = {}) {
    const { hint = '', sceneDirection = '', teams = null, kits = null } = opts;
    const flux = this._imageProvider() === 'flux';
    const styleKey = opts.styleKey || this._pickSceneStyle();
    const styleDesc = AIVideoGenerator.SCENE_STYLES[styleKey] || AIVideoGenerator.SCENE_STYLES.cinematic;
    const parts = [];

    // Lead with the hard single-frame constraint so it dominates the prompt.
    parts.push(
      'A SINGLE photograph (one frame, one continuous scene) — NOT a collage, NOT a grid, ' +
      'NOT a multi-panel, split-screen, montage or sequence of shots.'
    );
    parts.push(`Cinematic, photorealistic football (soccer) scene depicting: ${subject}.`);
    if (hint) parts.push(`Context: ${hint}`);
    const dir = this._singleShotDirection(sceneDirection);
    if (dir) parts.push(`One single moment: ${dir}.`);
    if (teams && (teams.home || teams.away)) {
      const fixture = [teams.home, teams.away].filter(Boolean).join(' vs ');
      parts.push(`Match: ${fixture}.`);
    }
    if (kits && (kits.home || kits.away)) {
      const k = [];
      if (kits.home) k.push(`the main player and ALL his teammates wear the SAME ${kits.home} kit`);
      if (kits.away) k.push(`the opponents and all their teammates wear the SAME ${kits.away} kit`);
      parts.push(`CRITICAL kit accuracy (do not substitute a different club's colours, do not mix colours within a team): ${k.join('; ')}.`);
    } else {
      parts.push('All players on the same team wear identical matching kit colours; do not mix kit colours within one team.');
    }
    if (flux) {
      // Flux 2 does real likeness + legible text — depict the player directly.
      parts.push(
        'Depict the real, recognizable player accurately wearing the exact kit described above, ' +
        'face clearly visible, captured in ONE clear focal moment of action or celebration, ' +
        'dynamic motion. Packed stadium. No on-screen captions, no watermarks, no scoreboard graphics.'
      );
    } else {
      // gpt-image-1: face off-subject, no jersey text (it garbles names).
      parts.push(
        'Frame as a dynamic action shot — a player in motion mid-celebration or mid-play, ' +
        'shot from a distance or from behind / over the shoulder, motion blur, face turned away or not the focus. ' +
        'Plain kits with NO names, NO numbers, NO readable text of any kind on the jerseys. ' +
        'Packed stadium. No text, no watermarks, no scoreboard graphics, ' +
        'no attempt to depict a specific real identifiable person\'s face.'
      );
    }
    // Structural realism guardrails. Image models often render a broadcast-style
    // goal with the NET billowing OUTSIDE the frame of the posts/crossbar, or
    // floating mesh — call it out explicitly so the goal reads correctly.
    parts.push(
      'Anatomically and structurally correct: if a goal is shown, the net is attached ' +
      'inside and behind the goalposts and crossbar and stays within the goal frame ' +
      '(no net extending past the posts, no floating or detached mesh); correct number ' +
      'of limbs; realistic stadium geometry.'
    );
    // Photographic style (randomly picked per image from SCENE_STYLES for visual
    // variety across the channel; was always "cinematic").
    parts.push(`Photographic style: ${styleDesc}.`);
    return parts.join(' ');
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      modern: "clean modern design, bright natural lighting, professional photography, shallow depth of field",
      cinematic: "cinematic lighting, dramatic composition, film still aesthetic, high contrast, moody atmosphere",
      animated: "3D rendered illustration, vibrant colors, stylized, Pixar-quality, playful",
      minimalist: "minimalist composition, pastel tones, clean background, editorial photography",
      tech: "futuristic tech aesthetic, neon accents, dark background, sleek modern devices",
      lifestyle: "lifestyle photography, warm golden hour light, authentic candid feel, cozy atmosphere",
    };

    const enhancement = styleEnhancements[style] || styleEnhancements.modern;
    return `${prompt}. Style: ${enhancement}. Ultra high quality, photorealistic, 16:9 widescreen composition. No text or watermarks.`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Generating video from assets...');

    try {
      // The ffmpeg slideshow is our REAL video path (Ken Burns, scoreboard
      // overlay, captions). The Replicate SVD path is experimental/opt-in and
      // uses a hardcoded model version — it must NOT auto-engage just because a
      // Replicate key is present for image generation. Gate it on REPLICATE_VIDEO.
      if (process.env.REPLICATE_VIDEO === 'true' && this.replicate && this.replicate.auth) {
        return await this.generateReplicateVideo(script, visualAssets, audioPath, outputPath);
      }

      // Default: ffmpeg slideshow assembly.
      return await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath, options);
    } catch (error) {
      this.logger.error('Video generation failed:', error);
      return await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath);
    }
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    // Use Stable Video Diffusion or similar model
    const output = await this.replicate.run(
      "stability-ai/stable-video-diffusion:3f0457e4619daac51203dedb1a4f46e66251bb3bfb18edd25d728dda8aa28ab7",
      {
        input: {
          cond_aug: 0.02,
          decoding_t: 7,
          input_image: visualAssets[0], // Use first image as base
          video_length: "14_frames_with_svd",
          sizing_strategy: "maintain_aspect_ratio",
          motion_bucket_id: 127,
          fps_id: 6
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    // Resolution-aware: default landscape 1920x1080; Shorts pass 1080x1920.
    const W = options.width || 1920;
    const H = options.height || 1080;
    const SCALE_PAD = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
    this.logger.info(`Creating dynamic video with ffmpeg... (${W}x${H})`);

    const duration = this.calculateScriptDuration(script);
    const { execSync } = require('child_process');
    const fsSync = require('fs');

    // Reset per-run clip metadata (the generator instance is shared/reused).
    this._lastClipMeta = null;

    // Filter to actual image files
    const validAssets = visualAssets.filter(a => {
      try { return fsSync.existsSync(a) && fsSync.statSync(a).size > 1000; } catch { return false; }
    });

    const videoPath = outputPath.replace('.mp4', '_visual.mp4');
    const tempDir = path.join(path.dirname(outputPath), '.tmp_video');
    await fs.mkdir(tempDir, { recursive: true });

    if (validAssets.length === 0) {
      // No usable imagery (e.g. image gen 429'd to placeholders). Build a real
      // title-card video instead of failing. NOTE: this ffmpeg build has no
      // libfreetype, so we render the title with sharp (SVG) and loop that still
      // image — NEVER drawtext (which doesn't exist here and breaks on punctuation).
      this.logger.warn('No valid visual assets, generating title-card video');
      const card = await this._makePlaceholderCard(script.title || 'Video', tempDir, { width: W, height: H });
      if (card) {
        const cmd = `ffmpeg -y -loop 1 -i "${card}" -t ${duration} ` +
          `-c:v libx264 -preset veryfast -pix_fmt yuv420p -r 30 -vf "scale=${W}:${H}" "${videoPath}"`;
        execSync(cmd, { stdio: 'pipe', timeout: 120000 });
      } else {
        // sharp unavailable: plain solid-color clip (no text), still a valid mp4.
        const cmd = `ffmpeg -y -f lavfi -i "color=c=0x1a1a2e:s=${W}x${H}:d=${duration}:r=30" ` +
          `-c:v libx264 -preset veryfast -pix_fmt yuv420p "${videoPath}"`;
        execSync(cmd, { stdio: 'pipe', timeout: 60000 });
      }
    } else {
      // Calculate per-section durations from script
      const sectionDurations = this._getSectionDurations(script, duration, validAssets.length);

      // Pick a random video style for variety
      const videoStyle = this._pickVideoStyle();
      this.logger.info(`Video style: ${videoStyle.name}`);

      // OPTIONAL stock-clip layer (Shorts): when options.useClips is set, resolve
      // a real B-roll clip per scene (Pexels), falling back to the Flux still.
      // sceneVisuals[i] = { type:'clip'|'card'|'still', ... }:
      //   clip  -> full-screen stock clip (atmosphere beat)
      //   card  -> accurate Flux still as a centered card over a blurred clip bed (action beat)
      //   still -> Flux still + Ken Burns (no clip found, or clips off — unchanged)
      let sceneVisuals = validAssets.map((a) => ({ type: 'still', source: a }));
      if (options.useClips) {
        try {
          const resolved = await this._resolveSceneVisuals(script, validAssets, options);
          sceneVisuals = resolved.visuals;
          const clipN = sceneVisuals.filter((s) => s.type === 'clip').length;
          const cardN = sceneVisuals.filter((s) => s.type === 'card').length;
          this.logger.info(`Stock clips (${resolved.mode}): ${clipN} clip + ${cardN} card / ${sceneVisuals.length} scene(s)`);
        } catch (e) {
          this.logger.warn(`Stock-clip resolution failed (${e.message}); using stills`);
        }
      }
      // Surface per-scene source for the dashboard (i) info panel.
      this._lastClipMeta = sceneVisuals.map((s) => ({ type: s.type, query: s.query || null }));

      // Generate individual clips with effects per section
      const clipPaths = [];
      for (let i = 0; i < validAssets.length; i++) {
        const clipPath = path.join(tempDir, `clip_${i}.mp4`);
        const clipDuration = sectionDurations[i] || Math.floor(duration / validAssets.length);
        const sectionTitle = this._getSectionTitle(script, i);
        const scene = sceneVisuals[i] || { type: 'still', source: validAssets[i] };

        // Build the Ken Burns / fade filter that operates on the raw image.
        const filter = this._buildClipFilter(i, validAssets.length, clipDuration, sectionTitle, videoStyle, { width: W, height: H });

        // Generate a full-frame transparent text overlay and composite it AFTER
        // zoompan via ffmpeg overlay, so the title is never cropped by the zoom.
        // Match-recap mode: show a scoreboard band (flags + score) instead of the
        // plain section title, so the video reads as an actual match recap.
        let textOverlay = options.match
          ? await this._makeScoreboardOverlay(options.match, tempDir, i, { width: W, height: H })
          : await this._makeTextOverlay(sectionTitle, tempDir, i, { width: W, height: H });

        // BOLD FIRST-FRAME HOOK: on the opening scene only, burn a big curiosity-gap
        // line across the top (the single biggest Shorts retention lever). Merged
        // into the scene's overlay PNG so every scene-type path (clip/card/still)
        // shows it. Portrait/Shorts only by default. options.hookText drives it.
        if (i === 0 && options.hookText && H > W) {
          try {
            textOverlay = await this._mergeHookOverlay(textOverlay, options.hookText, tempDir, { width: W, height: H });
          } catch (e) { this.logger.warn(`Hook overlay failed: ${e.message}`); }
        }

        // CLIP scene: render the real B-roll (cover-crop, no zoompan) with the
        // same overlay. Retry ONCE on failure (a timeout is usually transient
        // machine load) before falling through to the still path below.
        if (scene.type === 'clip') {
          try {
            await this._withRenderRetry(`Clip scene ${i}`, () =>
              this._renderClipScene(scene.source, clipPath, clipDuration, textOverlay, { width: W, height: H }));
            clipPaths.push(clipPath);
            continue;
          } catch (e) {
            this.logger.warn(`Clip scene ${i} render failed after retry (${e.message}); falling back to still`);
            if (this._lastClipMeta[i]) this._lastClipMeta[i] = { type: 'still', query: null };
          }
        }

        // CARD scene: accurate still as a centered card over a blurred clip bed.
        // The overlay (title band or scoreboard) is REBUILT at card dimensions
        // inside the renderer so its band sits flush at the top of the card (not
        // floating mid-image). Retry ONCE before falling through to the still.
        if (scene.type === 'card') {
          try {
            await this._withRenderRetry(`Card scene ${i}`, () =>
              this._renderCardScene(scene.clip, scene.still, clipPath, clipDuration,
                { match: options.match, sectionTitle }, { width: W, height: H }, i, tempDir));
            clipPaths.push(clipPath);
            continue;
          } catch (e) {
            this.logger.warn(`Card scene ${i} render failed after retry (${e.message}); falling back to still`);
            if (this._lastClipMeta[i]) this._lastClipMeta[i] = { type: 'still', query: null };
          }
        }

        // zoompan encoding is CPU-heavy; use a fast preset + all cores, and a
        // timeout that scales with clip length (so long sections don't get
        // killed mid-encode and fall back to a static clip).
        const enc = `-c:v libx264 -preset veryfast -threads 0 -pix_fmt yuv420p -r 30`;
        const clipTimeout = Math.max(120000, Math.ceil(clipDuration) * 8000);

        let cmd;
        if (textOverlay) {
          // [0]=looped image -> kenburns -> [bg]; overlay [1]=text PNG on top.
          cmd = `ffmpeg -y -loop 1 -i "${validAssets[i]}" -i "${textOverlay}" -t ${clipDuration} ` +
            `-filter_complex "[0:v]${filter}[bg];[bg][1:v]overlay=0:0:format=auto" ` +
            `${enc} "${clipPath}"`;
        } else {
          cmd = `ffmpeg -y -loop 1 -i "${validAssets[i]}" -t ${clipDuration} ` +
            `-vf "${filter}" ${enc} "${clipPath}"`;
        }
        try {
          execSync(cmd, { stdio: 'pipe', timeout: clipTimeout });
          clipPaths.push(clipPath);
        } catch (e) {
          this.logger.warn(`Clip ${i} generation failed (${e.message}), using simple scale`);
          // Fallback: static scaled image + the text overlay (no Ken Burns).
          const overlayInput = textOverlay ? ` -i "${textOverlay}"` : '';
          const overlayFilter = textOverlay
            ? `-filter_complex "[0:v]${SCALE_PAD},fps=30[bg];[bg][1:v]overlay=0:0:format=auto"`
            : `-vf "${SCALE_PAD},fps=30"`;
          const fallback = `ffmpeg -y -loop 1 -i "${validAssets[i]}"${overlayInput} -t ${clipDuration} ` +
            `${overlayFilter} ${enc} "${clipPath}"`;
          execSync(fallback, { stdio: 'pipe', timeout: clipTimeout });
          clipPaths.push(clipPath);
        }
      }

      // Concatenate clips with transitions
      if (clipPaths.length === 1) {
        await fs.copyFile(clipPaths[0], videoPath);
      } else {
        const listFile = path.join(tempDir, 'clips.txt');
        const listContent = clipPaths.map(p => `file '${p}'`).join('\n');
        await fs.writeFile(listFile, listContent);
        // Clips already share codec/params, so stream-copy concat is near-instant
        // (no re-encode). Falls back to re-encode if copy fails.
        try {
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${videoPath}"`,
            { stdio: 'pipe', timeout: 120000 });
        } catch (e) {
          this.logger.warn(`Concat copy failed (${e.message}), re-encoding`);
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset veryfast -pix_fmt yuv420p "${videoPath}"`,
            { stdio: 'pipe', timeout: 300000 });
        }
      }
    }

    // Add audio. Do NOT silently swallow a mux failure and ship a silent video
    // (that bit us once: a clip-scene timeout left the pipeline degraded and the
    // narration was dropped). Retry once; only fall back to the silent video if
    // the mux truly can't be done.
    let finalPath = videoPath;
    const haveAudio = audioPath && fsSync.existsSync(audioPath) && fsSync.statSync(audioPath).size > 100;
    if (haveAudio) {
      let muxed = false;
      for (let attempt = 1; attempt <= 2 && !muxed; attempt++) {
        try {
          await this.addAudioToVideo(videoPath, audioPath, outputPath);
          // Verify the output actually has an audio stream before trusting it.
          if (this._hasAudioStream(outputPath)) {
            muxed = true;
            try { await fs.unlink(videoPath); } catch {}
            finalPath = outputPath;
          } else {
            throw new Error('output has no audio stream after mux');
          }
        } catch (e) {
          this.logger.warn(`Audio mux attempt ${attempt}/2 failed: ${e.message}`);
        }
      }
      if (!muxed) this.logger.error('Audio mux failed after retries; shipping video WITHOUT audio');
    } else if (audioPath) {
      this.logger.warn('Narration audio missing/empty; video will have no audio');
    }
    if (finalPath === videoPath) {
      await fs.rename(videoPath, outputPath);
    }

    // Cleanup temp
    try { await this.cleanupDirectory(tempDir); } catch {}

    return outputPath;
  }

  /**
   * Pick a random video style for variety across videos.
   */
  _pickVideoStyle() {
    const styles = [
      {
        name: 'ken-burns',
        zoompan: true,
        textPosition: 'bottom-left',
        textBg: true,
      },
      {
        name: 'cinematic',
        zoompan: true,
        textPosition: 'center-bottom',
        textBg: true,
      },
      {
        name: 'clean',
        zoompan: false,
        textPosition: 'top-left',
        textBg: true,
      },
      {
        name: 'dynamic',
        zoompan: true,
        textPosition: 'bottom-center',
        textBg: false,
      },
    ];
    return styles[Math.floor(Math.random() * styles.length)];
  }

  /**
   * Build ffmpeg filter for a single clip with Ken Burns, fades, etc.
   * Text overlays are done via sharp pre-processing (ffmpeg drawtext unavailable).
   */
  _buildClipFilter(index, totalClips, clipDuration, sectionTitle, style, dims = {}) {
    const W = dims.width || 1920;
    const H = dims.height || 1080;
    const filters = [];
    const fps = 30;
    const totalFrames = clipDuration * fps;

    // Scale to fit target resolution
    filters.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`);

    // Ken Burns effect (slow zoom/pan) -- varies direction per clip.
    // IMPORTANT: zoompan crops toward the center as it zooms, so we keep the
    // max zoom modest (1.10) and ALWAYS start at zoom=1.0 on the first frame.
    // The 'on' (output frame number) is 0-based; the classic zoompan bug is
    // that 'zoom' resets to 1 each frame unless seeded, so we drive zoom from
    // 'on' directly instead of accumulating, guaranteeing a clean 1.0 start.
    if (style.zoompan) {
      const zMax = 1.10;
      const zStep = (zMax - 1.0) / Math.max(1, totalFrames - 1);
      const zoomIn  = `1.0+${zStep.toFixed(6)}*on`;                 // 1.0 -> zMax
      const zoomOut = `${zMax}-${zStep.toFixed(6)}*on`;            // zMax -> 1.0
      const cx = `iw/2-(iw/zoom/2)`;
      const cy = `ih/2-(ih/zoom/2)`;
      const S = `${W}x${H}`;
      const directions = [
        // Slow zoom in (centered) - starts at full frame, text visible at start
        `zoompan=z='min(${zoomIn},${zMax})':d=${totalFrames}:x='${cx}':y='${cy}':s=${S}:fps=${fps}`,
        // Slow zoom out (centered) - ends at full frame
        `zoompan=z='max(${zoomOut},1.0)':d=${totalFrames}:x='${cx}':y='${cy}':s=${S}:fps=${fps}`,
        // Gentle pan left->right at a fixed modest zoom
        `zoompan=z='1.06':d=${totalFrames}:x='(iw-iw/zoom)*on/${totalFrames}':y='${cy}':s=${S}:fps=${fps}`,
        // Gentle pan right->left at a fixed modest zoom
        `zoompan=z='1.06':d=${totalFrames}:x='(iw-iw/zoom)*(1-on/${totalFrames})':y='${cy}':s=${S}:fps=${fps}`,
      ];
      filters.length = 0; // zoompan handles scaling
      filters.push(directions[index % directions.length]);
    }

    // Fade in (first 0.5s) and fade out (last 0.5s)
    filters.push(`fade=in:0:${Math.min(15, totalFrames)},fade=out:${Math.max(0, totalFrames - 15)}:15`);

    filters.push(`fps=${fps}`);
    return filters.join(',');
  }

  // ---- Stock-clip (Pexels) support ------------------------------------------
  // Generic football B-roll layered into Shorts. See utils/pexels-provider.js.
  // All of this is OFF unless the caller passes options.useClips (the
  // /generate-short flow resolves that from a DB toggle / per-run override).

  /**
   * Derive a Pexels search query + BEAT TYPE for a scene from the script's OWN
   * visual direction + keywords, sanitized to GENERIC football terms (no team/
   * player names — Pexels has no real-player footage and we want copyright-safe,
   * non-specific B-roll). Deterministic, no LLM cost.
   *
   * Returns { query, beat }:
   *   beat='atmosphere' -> crowd/celebration/stadium: generic clip is FINE as a
   *     full-screen visual (nobody expects a specific face in a crowd shot).
   *   beat='action' -> a specific action (strike, save, dribble): a generic clip
   *     is OFF-narrative, so the accurate Flux still should lead — we use the
   *     clip only as a motion BED behind a framed-card composite of the still.
   * `index` rotates a fallback so scenes don't all reuse one clip.
   */
  _sceneClipQuery(script, index) {
    const sections = (script.mainContent && script.mainContent.sections) || [];
    const sec = sections[index] || {};
    const raw = [
      Array.isArray(sec.visuals) ? sec.visuals.join(' ') : sec.visuals,
      sec.title,
      Array.isArray(script.keywords) ? script.keywords.join(' ') : '',
    ].filter(Boolean).join(' ').toLowerCase();

    // Map narration cues to safe, evergreen B-roll terms + classify the beat.
    // ORDER MATTERS: specific actions are checked before generic atmosphere so
    // "celebrating goal" (action-ish but crowd-safe) lands as atmosphere while
    // "thunderous strike" lands as action.
    // Queries bias toward STADIUM / daytime-pitch footage (greener, brighter,
    // reads as a real match) over tight/dark close-ups. Brightness is further
    // enforced by the provider's luminance probe.
    const TERMS = [
      { re: /save|keeper|goalkeeper|dive/,                 q: 'soccer goalkeeper stadium pitch',  beat: 'action' },
      { re: /strike|shot|volley|header|finish|score(?!board)/, q: 'soccer player shooting stadium pitch', beat: 'action' },
      { re: /dribbl|skill|run|sprint|pace|solo/,           q: 'soccer player running stadium pitch', beat: 'action' },
      { re: /pass|assist|midfield|build/,                  q: 'soccer match stadium pitch daytime', beat: 'action' },
      { re: /celebrat|cheer|roar|jubilant/,                q: 'soccer players celebrating stadium', beat: 'atmosphere' },
      { re: /crowd|fans|stadium|stands|supporter/,         q: 'football stadium crowd cheering',  beat: 'atmosphere' },
      { re: /night|lights|floodlight/,                     q: 'football stadium full crowd',      beat: 'atmosphere' },
      { re: /trophy|win|champion|victory/,                 q: 'soccer stadium celebration crowd', beat: 'atmosphere' },
    ];
    // pureCrowd: the scene is EXCLUSIVELY about crowd/stands/trophy with no
    // specific subject (no player, goal, moment, match action). Only these get a
    // full-screen ambient clip; everything else defaults to the card so the
    // accurate still leads. "fan reactions + key moments" is NOT pureCrowd (it
    // mentions a subject), so a recap still leads as intended.
    const crowdOnly = /\b(crowd|fans?|stands|supporters?|spectators?|trophy|lift(ing)? the|celebration)\b/.test(raw);
    const hasSubject = /\b(goal|moment|player|strike|shot|save|keeper|dribbl|skill|run|header|volley|finish|assist|pass|highlight|key|star|hero|match)\b/.test(raw);
    const pureCrowd = crowdOnly && !hasSubject;

    for (const t of TERMS) if (t.re.test(raw)) return { query: t.q, beat: t.beat, pureCrowd };
    // Generic rotation. No specific cue -> default to a card (still leads); these
    // are never pureCrowd.
    const fallback = [
      'soccer match stadium pitch daytime',
      'football stadium crowd cheering',
      'soccer players celebrating stadium',
      'football pitch green grass stadium',
    ];
    return { query: fallback[index % fallback.length], beat: 'atmosphere', pureCrowd: false };
  }

  /**
   * For each scene, decide whether to use a stock clip or the Flux still.
   * Returns an array of { type:'clip'|'still', source, query? } aligned to
   * validAssets. In 'background' mode only ONE clip is resolved (used full-frame
   * behind every overlay). FAILS OPEN: any clip miss => that scene stays a still.
   */
  async _resolveSceneVisuals(script, validAssets, options) {
    const portrait = (options.height || 1080) > (options.width || 1920);
    const pexels = require('./pexels-provider');
    const shortsConfig = require('./shorts-config');
    const minSec = (shortsConfig.stockClips && shortsConfig.stockClips.minClipSec) || 4;
    const mode = options.clipMode || (shortsConfig.stockClips && shortsConfig.stockClips.mode) || 'mix';
    const visuals = [];

    const getClipOpts = { portrait, width: options.width || 1080, height: options.height || 1920, minSec, logger: this.logger };

    if (mode === 'background') {
      // One clip for the whole short; fall back to per-scene stills if none.
      const { query } = this._sceneClipQuery(script, 0);
      const clip = await pexels.getClip(query, getClipOpts);
      for (let i = 0; i < validAssets.length; i++) {
        visuals.push(clip ? { type: 'clip', source: clip, query } : { type: 'still', source: validAssets[i] });
      }
      if (clip && this.costMeter) this.costMeter.recordStockClip(query, { label: 'Stock clip (bg)' });
      return { visuals, mode };
    }

    // mix: per scene, the CARD is the default (the accurate Flux still leads,
    // with the clip as a blurred motion bed) — the still is the on-narrative
    // asset, so it should be front-and-centre on (almost) every scene. A
    // full-screen clip is used ONLY for genuinely pure-crowd/celebration scenes
    // (`pureCrowd`), where there's no specific subject to show and ambient
    // footage reads fine. No clip found -> plain still (Ken Burns), unchanged.
    for (let i = 0; i < validAssets.length; i++) {
      const { query, beat, pureCrowd } = this._sceneClipQuery(script, i);
      let clip = null;
      try { clip = await pexels.getClip(query, getClipOpts); } catch { clip = null; }

      if (!clip) {
        visuals.push({ type: 'still', source: validAssets[i] });
        continue;
      }
      if (this.costMeter) this.costMeter.recordStockClip(query);
      if (pureCrowd) {
        // Pure crowd/celebration: ambient full-screen clip is fine here.
        visuals.push({ type: 'clip', source: clip, query, beat });
      } else {
        // Default: accurate still front-and-centre, clip behind it.
        visuals.push({ type: 'card', clip, still: validAssets[i], query, beat });
      }
    }
    return { visuals, mode };
  }

  /**
   * Render one SCENE that is a video clip (not a still): cover-scale/crop the
   * source mp4 to the target frame, trim/loop to clipDuration, add the same
   * fade as stills, and composite the SAME text/scoreboard overlay on top. No
   * zoompan (the clip already moves). Mirrors the still path's ffmpeg shape so
   * the resulting clip shares codec/fps/resolution and concats by stream-copy.
   */
  // Run a render fn, retrying once on failure. A render timeout (ETIMEDOUT) is
  // almost always transient machine load (the daily batch thrashing CPU); a brief
  // pause + retry usually succeeds, avoiding a needless still fallback. Throws if
  // the retry also fails (caller then falls back to a still).
  async _withRenderRetry(label, fn) {
    try {
      return await fn();
    } catch (e) {
      this.logger.warn(`${label} render failed (${e.message}); retrying once after a short pause…`);
      await new Promise((r) => setTimeout(r, 3000));
      return await fn();
    }
  }

  // True if the file has at least one audio stream (used to verify a mux worked).
  _hasAudioStream(p) {
    try {
      const { execSync } = require('child_process');
      const out = execSync(`ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${p}"`,
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).toString().trim();
      return /audio/.test(out);
    } catch { return false; }
  }

  // Probe a media file's duration (seconds) via ffprobe. Synchronous; returns
  // null on failure (caller picks a sane default).
  _probeDuration(p) {
    try {
      const { execSync } = require('child_process');
      const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`,
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).toString().trim();
      const d = parseFloat(out);
      return Number.isFinite(d) && d > 0 ? d : null;
    } catch { return null; }
  }

  async _renderClipScene(srcClip, clipPath, clipDuration, textOverlay, dims) {
    const { execSync } = require('child_process');
    const W = dims.width || 1920, H = dims.height || 1080, fps = 30;
    const totalFrames = Math.round(clipDuration * fps);
    // Cover-crop to exact frame (no black bars), set fps, fade in/out, trim.
    const base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `fps=${fps},fade=in:0:${Math.min(15, totalFrames)},fade=out:${Math.max(0, totalFrames - 15)}:15`;
    const enc = `-c:v libx264 -preset veryfast -threads 0 -pix_fmt yuv420p -r ${fps}`;
    // Loop the source to fill clipDuration. -stream_loop with an explicit count
    // (not -1) avoids ffmpeg over-decoding an unbounded loop, which could crawl
    // and time out on long scenes. -t still trims to the exact duration. -an
    // drops the source clip's own audio (we mux narration later).
    const srcDur = this._probeDuration(srcClip) || 8;
    const loops = Math.min(50, Math.ceil(clipDuration / Math.max(1, srcDur)) + 1);
    const enc2 = `${enc} -an`;
    const timeout = Math.max(180000, Math.ceil(clipDuration) * 12000);
    let cmd;
    if (textOverlay) {
      cmd = `ffmpeg -y -stream_loop ${loops} -i "${srcClip}" -i "${textOverlay}" -t ${clipDuration} ` +
        `-filter_complex "[0:v]${base}[bg];[bg][1:v]overlay=0:0:format=auto" ${enc2} "${clipPath}"`;
    } else {
      cmd = `ffmpeg -y -stream_loop ${loops} -i "${srcClip}" -t ${clipDuration} -vf "${base}" ${enc2} "${clipPath}"`;
    }
    execSync(cmd, { stdio: 'pipe', timeout });
    return clipPath;
  }

  /**
   * Build a rounded-corner "card" PNG from a still image: cover-crop the still
   * to the card box, round the corners (sharp SVG mask), and add a soft drop
   * shadow on a transparent canvas. Returns { path, w, h } (card incl. shadow
   * margin) or null if sharp is unavailable. cardW = target card width in px.
   */
  async _makeStillCard(stillPath, tempDir, index, cardW, cardH) {
    if (!sharp) return null;
    try {
      const radius = Math.round(Math.min(cardW, cardH) * 0.05); // 5% corner radius
      const pad = Math.round(cardW * 0.04); // shadow margin around the card
      // Cover-crop the still into the card box.
      const cropped = await sharp(stillPath).resize(cardW, cardH, { fit: 'cover' }).png().toBuffer();
      // Rounded-rect mask.
      const mask = Buffer.from(
        `<svg width="${cardW}" height="${cardH}"><rect x="0" y="0" width="${cardW}" height="${cardH}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`
      );
      const rounded = await sharp(cropped)
        .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
      // Soft shadow: a blurred dark rounded-rect behind the card, on a padded
      // transparent canvas so the blur isn't clipped.
      const canvasW = cardW + pad * 2, canvasH = cardH + pad * 2;
      const shadowRect = Buffer.from(
        `<svg width="${canvasW}" height="${canvasH}"><rect x="${pad}" y="${pad + Math.round(pad*0.4)}" width="${cardW}" height="${cardH}" rx="${radius}" ry="${radius}" fill="#000"/></svg>`
      );
      const shadow = await sharp(shadowRect).blur(Math.max(4, Math.round(pad * 0.6))).png().toBuffer();
      const out = path.join(tempDir, `card_${index}.png`);
      await sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
          { input: shadow, top: 0, left: 0 },
          { input: rounded, top: pad, left: pad },
        ]).png().toFile(out);
      return { path: out, w: canvasW, h: canvasH };
    } catch (e) {
      this.logger.warn(`_makeStillCard failed (${e.message})`);
      return null;
    }
  }

  /**
   * Render an "action" SCENE as a framed-card composite: the accurate Flux still
   * sits as a centered rounded card over a BLURRED + DIMMED motion bed (the
   * stock clip), with the SAME text/scoreboard overlay on top. Keeps the still's
   * narrative accuracy while adding ambient motion. Card width is tunable via
   * STOCK_CARD_WIDTH_PCT (default 0.65 = 65% of frame width). On any failure the
   * caller falls back to the plain still path.
   */
  async _renderCardScene(srcClip, stillPath, clipPath, clipDuration, overlaySpec, dims, index, tempDir) {
    const { execSync } = require('child_process');
    const W = dims.width || 1920, H = dims.height || 1080, fps = 30;
    const totalFrames = Math.round(clipDuration * fps);
    const pct = Math.min(0.95, Math.max(0.4, parseFloat(process.env.STOCK_CARD_WIDTH_PCT || '0.82')));
    const cardW = Math.round(W * pct / 2) * 2; // even dims for yuv420p
    // Card height from the still's own aspect ratio (so it isn't distorted).
    let aspect = H / W;
    try { const m = await sharp(stillPath).metadata(); if (m.width && m.height) aspect = m.height / m.width; } catch {}
    const cardH = Math.round(cardW * aspect / 2) * 2;

    const card = await this._makeStillCard(stillPath, tempDir, index, cardW, cardH);
    if (!card) throw new Error('card build failed');

    // Rebuild the overlay (scoreboard or title) at CARD dimensions, so its band
    // sits flush at the top of the card (not floating mid-image like a full-frame
    // overlay cropped to the card would). overlaySpec = { match?, sectionTitle? }.
    let cardOverlay = null;
    if (overlaySpec && overlaySpec.match) {
      // topFlush: band starts at the card's top edge (no gap above it).
      cardOverlay = await this._makeScoreboardOverlay(overlaySpec.match, tempDir, `card${index}`, { width: cardW, height: cardH, topFlush: true });
    } else if (overlaySpec && overlaySpec.sectionTitle) {
      cardOverlay = await this._makeTextOverlay(overlaySpec.sectionTitle, tempDir, `card${index}`, { width: cardW, height: cardH });
    }

    // Background: lightly blurred + slightly dimmed clip, cover-cropped to frame,
    // faded, looped. Blur is kept modest so the football STILL READS as football
    // behind the card. Tunables: STOCK_BG_BLUR (default 10), STOCK_BG_DIM (0.12).
    const blur = parseInt(process.env.STOCK_BG_BLUR || '10');
    const dim = parseFloat(process.env.STOCK_BG_DIM || '0.12');
    const bg = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `boxblur=${blur}:1,eq=brightness=-${dim},fps=${fps},` +
      `fade=in:0:${Math.min(15, totalFrames)},fade=out:${Math.max(0, totalFrames - 15)}:15`;
    const cx = Math.round((W - card.w) / 2), cy = Math.round((H - card.h) / 2);
    const cardPad = Math.round((card.w - cardW) / 2); // shadow margin per side
    const innerX = cx + cardPad;                      // left edge of the still
    const innerY = cy + cardPad;                      // top edge of the still
    // Bounded loop count (not -1) so the bg clip never over-decodes and stalls.
    const srcDur = this._probeDuration(srcClip) || 8;
    const loops = Math.min(50, Math.ceil(clipDuration / Math.max(1, srcDur)) + 1);
    const enc = `-c:v libx264 -preset veryfast -threads 0 -pix_fmt yuv420p -r ${fps} -an`;
    const timeout = Math.max(180000, Math.ceil(clipDuration) * 12000);

    // Inputs: [0]=clip (looped), [1]=card PNG, [2]=card-sized overlay (optional),
    // [3]=rounded mask. [0]->bg; bg+card -> [c]; overlay (clipped to the card's
    // rounded corners so its band top follows the curve) -> on top at the still.
    let cmd;
    if (cardOverlay) {
      const radius = Math.round(Math.min(cardW, cardH) * 0.05); // match _makeStillCard
      // White rounded-rect on BLACK (luma = card silhouette). MULTIPLY the
      // overlay's own alpha by this so the band keeps its transparency AND is
      // clipped to the card's rounded corners.
      const maskSvg = Buffer.from(
        `<svg width="${cardW}" height="${cardH}"><rect width="${cardW}" height="${cardH}" fill="#000"/>` +
        `<rect x="0" y="0" width="${cardW}" height="${cardH}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`
      );
      const maskPath = path.join(tempDir, `cardmask_${index}.png`);
      await sharp(maskSvg).removeAlpha().png().toFile(maskPath);
      cmd = `ffmpeg -y -stream_loop ${loops} -i "${srcClip}" -i "${card.path}" -i "${cardOverlay}" -i "${maskPath}" -t ${clipDuration} ` +
        `-filter_complex "[0:v]${bg}[bg];[bg][1:v]overlay=${cx}:${cy}[c];` +
        `[2:v]format=rgba,split[txa][txb];` +
        `[txa]alphaextract[oa];` +
        `[3:v]format=gray[mk];` +
        `[oa][mk]blend=all_mode=multiply[a2];` +
        `[txb][a2]alphamerge[txtr];` +
        `[c][txtr]overlay=${innerX}:${innerY}:format=auto" ` +
        `${enc} "${clipPath}"`;
    } else {
      cmd = `ffmpeg -y -stream_loop ${loops} -i "${srcClip}" -i "${card.path}" -t ${clipDuration} ` +
        `-filter_complex "[0:v]${bg}[bg];[bg][1:v]overlay=${cx}:${cy}" ${enc} "${clipPath}"`;
    }
    execSync(cmd, { stdio: 'pipe', timeout });
    return clipPath;
  }

  /**
   * Build a BOLD first-frame HOOK overlay (big curiosity-gap line across the TOP)
   * and merge it onto the scene's existing overlay PNG (caption/scoreboard). The
   * hook is the single biggest Shorts retention lever — it must read instantly.
   * Big uppercase text, heavy black stroke, semi-opaque band behind it for
   * legibility over any image. Returns a new merged overlay PNG path. If `base`
   * is null, returns a hook-only overlay.
   */
  async _mergeHookOverlay(base, hookText, tempDir, dims = {}) {
    if (!sharp) return base;
    const W = dims.width || 1080, H = dims.height || 1920;
    const text = String(hookText).toUpperCase().replace(/[.]+$/, '').trim();
    // Word-wrap to <= ~14 chars/line, max 3 lines.
    const words = text.split(/\s+/);
    const lines = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 14 && cur) { lines.push(cur); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    const safe = lines.slice(0, 3).map(l => this._escapeXml(l));

    const fontSize = 86;
    const lineH = fontSize * 1.15;
    const blockH = safe.length * lineH;
    const pad = 36;
    const bandTop = Math.round(H * 0.07);          // high, clear of the very top
    const bandH = blockH + pad * 2;
    const firstBaseline = bandTop + pad + fontSize;
    const textEls = safe.map((line, i) => {
      const y = firstBaseline + i * lineH;
      return `
        <text x="${W / 2}" y="${y}" text-anchor="middle"
          font-family="Arial Black, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
          stroke="#000000" stroke-width="10" fill="#000000" paint-order="stroke">${line}</text>
        <text x="${W / 2}" y="${y}" text-anchor="middle"
          font-family="Arial Black, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
          fill="#FFE600">${line}</text>`; // bright yellow = high-contrast attention
    }).join('');
    const svg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="hk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0.0"/>
          <stop offset="20%" stop-color="#000" stop-opacity="0.55"/>
          <stop offset="80%" stop-color="#000" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.0"/>
        </linearGradient></defs>
        <rect x="0" y="${bandTop - pad}" width="${W}" height="${bandH + pad * 2}" fill="url(#hk)"/>
        ${textEls}
      </svg>`);
    const hookPng = await sharp(svg).png().toBuffer();

    const out = path.join(tempDir, `hook_overlay.png`);
    if (base && fs && require('fs').existsSync(base)) {
      // Composite hook ON TOP of the existing caption/scoreboard overlay.
      await sharp(base).composite([{ input: hookPng, top: 0, left: 0 }]).png().toFile(out);
    } else {
      await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: hookPng, top: 0, left: 0 }]).png().toFile(out);
    }
    return out;
  }

  /**
   * Build a full-frame TRANSPARENT PNG containing just the section title in a
   * title-safe band. Composited over the clip AFTER zoompan (via ffmpeg
   * overlay), so text is never cropped/zoomed by Ken Burns. Dimension-aware:
   * landscape uses a lower-third; portrait (Shorts) places text higher and
   * larger, clear of the Shorts UI that covers the bottom of the screen.
   * Returns the overlay path, or null if sharp is unavailable / no title.
   */
  async _makeTextOverlay(sectionTitle, tempDir, index, dims = {}) {
    if (!sharp || !sectionTitle) return null;

    try {
      const W = dims.width || 1920;
      const H = dims.height || 1080;
      const portrait = H > W;

      // Portrait: bigger font, wrap to multiple lines, sit in the lower-middle
      // (Shorts overlay buttons/caption sit along the very bottom & right).
      const fontSize = portrait ? 64 : 52;
      const maxChars = portrait ? 22 : 60;       // chars per line before wrap
      const lineHeight = fontSize * 1.25;

      // Word-wrap the title into lines that fit the width.
      const words = String(sectionTitle).split(/\s+/);
      const lines = [];
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; }
        else { cur = (cur + ' ' + w).trim(); }
      }
      if (cur) lines.push(cur);
      const safeLines = lines.slice(0, portrait ? 4 : 2).map(l => this._escapeXml(l));

      const blockH = safeLines.length * lineHeight;
      const pad = portrait ? 40 : 30;
      const bandH = blockH + pad * 2;
      // Landscape: lower third. Portrait: ~68% down (clear of Shorts UI bottom).
      const bandTop = portrait ? Math.round(H * 0.66) : (H - bandH - 60);
      const firstBaseline = bandTop + pad + fontSize;

      const textEls = safeLines.map((line, i) => {
        const y = firstBaseline + i * lineHeight;
        return `
          <text x="${W / 2}" y="${y}" text-anchor="middle"
            font-family="Arial Black, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
            stroke="#000000" stroke-width="${portrait ? 6 : 5}" fill="#000000" paint-order="stroke">${line}</text>
          <text x="${W / 2}" y="${y}" text-anchor="middle"
            font-family="Arial Black, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
            fill="#FFFFFF">${line}</text>`;
      }).join('');

      const svgOverlay = Buffer.from(`
        <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
              <stop offset="50%" stop-color="#000000" stop-opacity="${portrait ? 0.55 : 0.78}"/>
              <stop offset="100%" stop-color="#000000" stop-opacity="${portrait ? 0.55 : 0.78}"/>
            </linearGradient>
          </defs>
          <rect x="0" y="${bandTop}" width="${W}" height="${bandH}" fill="url(#bg)"/>
          ${textEls}
        </svg>
      `);

      const outPath = path.join(tempDir, `textoverlay_${index}.png`);
      await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: svgOverlay, top: 0, left: 0 }])
        .png()
        .toFile(outPath);
      return outPath;
    } catch (e) {
      this.logger.warn(`Text overlay failed for clip ${index}: ${e.message}`);
      return null;
    }
  }

  // Full-frame title card (dark gradient background + centered, word-wrapped
  // title) rendered via sharp. Used as the placeholder-video frame when no real
  // imagery is available. Returns a PNG path, or null if sharp is unavailable.
  async _makePlaceholderCard(title, tempDir, dims = {}) {
    if (!sharp) return null;
    try {
      const W = dims.width || 1920;
      const H = dims.height || 1080;
      const portrait = H > W;
      const fontSize = portrait ? 72 : 64;
      const maxChars = portrait ? 18 : 36;
      const lineHeight = fontSize * 1.3;

      const words = String(title || 'Video').split(/\s+/);
      const lines = [];
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; }
        else { cur = (cur + ' ' + w).trim(); }
      }
      if (cur) lines.push(cur);
      const safeLines = lines.slice(0, 5).map(l => this._escapeXml(l));

      const blockH = safeLines.length * lineHeight;
      const firstBaseline = Math.round(H / 2 - blockH / 2 + fontSize);
      const textEls = safeLines.map((line, i) => {
        const y = firstBaseline + i * lineHeight;
        return `<text x="${W / 2}" y="${y}" text-anchor="middle"
            font-family="Arial Black, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
            fill="#FFFFFF">${line}</text>`;
      }).join('');

      const svg = Buffer.from(`
        <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#1a1a2e"/>
              <stop offset="100%" stop-color="#0f1117"/>
            </linearGradient>
          </defs>
          <rect width="${W}" height="${H}" fill="url(#bg)"/>
          ${textEls}
        </svg>`);

      const outPath = path.join(tempDir, 'placeholder_card.png');
      await sharp({ create: { width: W, height: H, channels: 4, background: { r: 26, g: 26, b: 46, alpha: 1 } } })
        .composite([{ input: svg, top: 0, left: 0 }])
        .png()
        .toFile(outPath);
      return outPath;
    } catch (e) {
      this.logger.warn(`Placeholder card render failed: ${e.message}`);
      return null;
    }
  }

  // Full-frame transparent overlay with a football SCOREBOARD band near the top:
  //   [CREST] HOME   homeScore - awayScore   AWAY [CREST]
  // plus an optional competition label. Composited over the AI scene clip the
  // same way as _makeTextOverlay. `match` = { homeTeam, awayTeam, homeScore,
  // awayScore, homeCrest, awayCrest, label }. homeCrest/awayCrest are LOCAL image
  // paths (the provider downloads them; emoji flags don't render in sharp). Names
  // fall back gracefully; crests are optional. index caches per-clip.
  async _makeScoreboardOverlay(match, tempDir, index = 0, dims = {}) {
    if (!sharp || !match) return null;
    try {
      const W = dims.width || 1920;
      const H = dims.height || 1080;
      const portrait = H > W;
      // topFlush: anchor the band at the very top (gap = small pad), used by the
      // card composite so the band starts exactly where the still starts.
      const topFlush = !!dims.topFlush;

      const home = this._escapeXml(String(match.homeTeam || 'Home'));
      const away = this._escapeXml(String(match.awayTeam || 'Away'));
      const hs = match.homeScore != null ? match.homeScore : '';
      const as = match.awayScore != null ? match.awayScore : '';
      const score = (hs !== '' || as !== '') ? `${hs} - ${as}` : 'vs';
      const label = match.label ? this._escapeXml(String(match.label)) : '';

      // Locked layout (matches the approved sb_plus10_121 mockup). Crests are
      // +10% and nudged DOWN from the score's optical center so they sit level
      // with the score instead of riding high; even top/bottom padding.
      const nameSize = portrait ? 50 : 56;
      const scoreSize = portrait ? 96 : 104;
      const crestSize = portrait ? 121 : 132;   // +10%
      const labelSize = portrait ? 30 : 32;
      const PAD_TOP = portrait ? 20 : 22;
      const PAD_BOTTOM = portrait ? 30 : 32;
      const gapLabelRow = portrait ? 30 : 32;   // label baseline -> row top
      const gapRowName = portrait ? 14 : 16;    // row bottom -> name
      const NUDGE = portrait ? 4 : 30;          // align crests to the score's optical centre
      const SCORE_CENTER_FACTOR = 0.370;        // measured optical center of digits

      const bandTop = topFlush ? 0 : (portrait ? Math.round(H * 0.10) : Math.round(H * 0.05));
      const cx = W / 2;
      const labelY = bandTop + PAD_TOP + labelSize;            // label baseline
      const rowTop = labelY + (label ? gapLabelRow : 0);
      const scoreY = rowTop + scoreSize;                       // score baseline
      const rowBottom = rowTop + Math.max(scoreSize, crestSize);
      const nameY = rowBottom + gapRowName + nameSize;         // name baseline
      const bandH = nameY + PAD_BOTTOM - bandTop;

      const scoreCenterY = scoreY - scoreSize * SCORE_CENTER_FACTOR;
      const crestTop = Math.round(scoreCenterY - crestSize / 2 + NUDGE);
      const leftX = W * (portrait ? 0.26 : 0.30);
      const rightX = W * (portrait ? 0.74 : 0.70);

      const txt = (x, y, s, size, weight = '900', anchor = 'middle') => `
        <text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial Black, Helvetica, sans-serif"
          font-size="${size}" font-weight="${weight}" stroke="#000" stroke-width="${Math.round(size/12)}"
          fill="#000" paint-order="stroke">${s}</text>
        <text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial Black, Helvetica, sans-serif"
          font-size="${size}" font-weight="${weight}" fill="#FFF">${s}</text>`;

      const svg = Buffer.from(`
        <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="sb" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#000" stop-opacity="0.82"/>
              <stop offset="100%" stop-color="#000" stop-opacity="0.62"/>
            </linearGradient>
          </defs>
          <rect x="0" y="${bandTop}" width="${W}" height="${bandH}" fill="url(#sb)"/>
          ${label ? txt(cx, labelY, label, labelSize, '700') : ''}
          ${txt(cx, scoreY, this._escapeXml(score), scoreSize)}
          ${txt(leftX, nameY, home, nameSize)}
          ${txt(rightX, nameY, away, nameSize)}
        </svg>`);

      // Composite: transparent base <- text SVG <- crest images (resized).
      const layers = [{ input: svg, top: 0, left: 0 }];
      const addCrest = async (crestPath, centerX) => {
        if (!crestPath) return;
        try {
          // 'contain' (not 'inside') pads each crest into a fixed crestSize×
          // crestSize transparent square. Flags have different aspect ratios
          // (e.g. a square PNG vs a wide SVG flag); with 'inside' they'd have
          // different output HEIGHTS, so placing both at the same `top` made
          // their centres misalign. A fixed square keeps both vertically centred
          // on the same line.
          const resized = await sharp(crestPath)
            .resize(crestSize, crestSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png().toBuffer();
          layers.push({ input: resized, top: Math.round(crestTop), left: Math.round(centerX - crestSize / 2) });
        } catch (e) { this.logger.warn(`Crest render skipped: ${e.message}`); }
      };
      await addCrest(match.homeCrest, leftX);
      await addCrest(match.awayCrest, rightX);

      const outPath = path.join(tempDir, `scoreboard_${index}.png`);
      await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(layers)
        .png()
        .toFile(outPath);
      return outPath;
    } catch (e) {
      this.logger.warn(`Scoreboard overlay render failed: ${e.message}`);
      return null;
    }
  }

  // ISO-3166 alpha-2 country code -> flag emoji (regional indicator pair).
  // Football-data.org gives team names, not codes, so we also map common
  // national-team names. Returns '' if unknown (overlay just omits the flag).
  _countryFlag(nameOrCode) {
    if (!nameOrCode) return '';
    const NAME_TO_CC = {
      brazil:'BR', argentina:'AR', france:'FR', england:'GB', spain:'ES', germany:'DE',
      portugal:'PT', netherlands:'NL', italy:'IT', croatia:'HR', belgium:'BE', usa:'US',
      'united states':'US', mexico:'MX', canada:'CA', japan:'JP', 'south korea':'KR',
      morocco:'MA', uruguay:'UY', colombia:'CO', poland:'PL', switzerland:'CH',
      denmark:'DK', senegal:'SN', ghana:'GH', nigeria:'NG', australia:'AU', qatar:'QA',
      ecuador:'EC', iran:'IR', serbia:'RS', wales:'GB', 'saudi arabia':'SA', tunisia:'TN',
      'costa rica':'CR', cameroon:'CM',
    };
    let cc = null;
    const key = String(nameOrCode).trim().toLowerCase();
    if (/^[a-z]{2}$/.test(key)) cc = key.toUpperCase();
    else if (NAME_TO_CC[key]) cc = NAME_TO_CC[key];
    if (!cc) return '';
    return cc.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
  }

  /**
   * Get per-section durations proportional to content length.
   */
  _getSectionDurations(script, totalDuration, assetCount) {
    const sections = script.mainContent?.sections || [];
    if (sections.length === 0) {
      // Equal split
      const per = Math.floor(totalDuration / assetCount);
      return Array(assetCount).fill(per);
    }

    // Weight by content length
    const weights = [];
    for (let i = 0; i < assetCount; i++) {
      const section = sections[i];
      if (section) {
        const contentLen = (section.content || '').length + (section.title || '').length;
        weights.push(Math.max(contentLen, 50));
      } else {
        weights.push(50);
      }
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => Math.max(3, Math.round((w / totalWeight) * totalDuration)));
  }

  /**
   * Get the title of script section at the given index.
   */
  _getSectionTitle(script, index) {
    const sections = script.mainContent?.sections || [];
    if (index < sections.length) {
      return sections[index].title || null;
    }
    return null;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.3;
            z-index: -1;
        }
        
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" />` : ''}
        <div class="content">
            <h1>${script.title}</h1>
            <p>${script.hook?.text || ''}</p>
        </div>
    </div>
    
    ${this.generateContentSlides(script, visualAssets).join('')}
    
    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>✨ Subscribe for More Stories ✨</h2>
            <p>New content daily at 2:00 PM</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" />` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }
    
    return '<p>Content coming soon...</p>';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook && script.hook.text) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion && script.conclusion.finalThought) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }

    // Shorts cap their own duration; respect an explicit numeric script.duration.
    const wordDuration = Math.max(30, Math.ceil((totalWords / 150) * 60));
    if (script.format === 'short') {
      const cap = (script.duration && Number.isFinite(script.duration)) ? script.duration : 58;
      return Math.min(wordDuration, cap);
    }
    return wordDuration;
  }

  async addAudioToVideo(videoPath, audioPath, outputPath) {
    // The narration length rarely matches the estimated video length. If we
    // just use -shortest, a longer narration gets its conclusion/CTA cut off.
    // So when audio is longer, freeze the last video frame to cover the gap;
    // otherwise keep the (cheaper) stream-copy + shortest path.
    const probe = (p) =>
      execAsync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`)
        .then(r => parseFloat((r.stdout || '0').trim()) || 0)
        .catch(() => 0);

    const [vDur, aDur] = await Promise.all([probe(videoPath), probe(audioPath)]);
    const gap = aDur - vDur;

    if (gap > 0.5) {
      // Extend video to the audio length by holding the last frame (tpad).
      this.logger.info(`Narration is ${gap.toFixed(1)}s longer than video; freezing last frame to fit.`);
      const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" ` +
        `-vf "tpad=stop_mode=clone:stop_duration=${(gap + 0.3).toFixed(2)}" ` +
        `-c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"`;
      await execAsync(cmd, { timeout: Math.max(180000, Math.ceil(aDur) * 8000) });
    } else {
      const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -shortest "${outputPath}"`;
      await execAsync(cmd, { timeout: 180000 });
    }
    this.logger.info('Audio added to video successfully');
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');
    
    try {
      if (!this.openai) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = [
        `Create a visually stunning ${style} photograph that represents the concept of: "${script.title}".`,
        'CRITICAL RULES:',
        '- DO NOT include ANY text, letters, words, numbers, titles, labels, captions, watermarks, or logos anywhere in the image.',
        '- DO NOT include any UI elements, text boxes, banners, or overlays.',
        '- This must be a PURE visual image with ZERO text of any kind.',
        'Style: bold saturated colors, high contrast, dramatic cinematic lighting.',
        'Composition: strong visual focal point, clean uncluttered lower third area.',
        'Quality: ultra-sharp, 4K, professional photography aesthetic, vibrant colors that pop on small screens.',
      ].join(' ');
      
      const response = await this._withRetry(() => this.openai.images.generate({
        model: "gpt-image-1",
        prompt: prompt,
        n: 1,
        size: "1536x1024",
        quality: "high"
      }), { label: 'Thumbnail generation' });
      if (this.costMeter) {
        this.costMeter.recordImage('1536x1024', 'high', { label: 'Thumbnail' });
      }

      const thumbnailDir = path.join(__dirname, '..', 'uploads', 'thumbnails');
      await fs.mkdir(thumbnailDir, { recursive: true });
      const rawPath = path.join(thumbnailDir, `thumbnail_${Date.now()}.png`);
      
      const imgData = response.data[0];
      if (imgData.b64_json) {
        await fs.writeFile(rawPath, Buffer.from(imgData.b64_json, 'base64'));
      } else if (imgData.url) {
        await this.downloadImage(imgData.url, rawPath);
      }

      // Overlay the title text using sharp (if available)
      const finalPath = await this._overlayTitleText(rawPath, script.title);
      
      return {
        path: finalPath,
        url: imgData.url || null,
        dimensions: { width: 1536, height: 1024 },
        fileSize: await this.getFileSize(finalPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  /**
   * Overlay bold title text onto a thumbnail image using sharp + SVG.
   * Falls back to returning the raw image path if sharp is unavailable.
   */
  async _overlayTitleText(imagePath, title) {
    if (!sharp) {
      this.logger.warn('sharp not available, skipping text overlay on thumbnail');
      return imagePath;
    }

    try {
      const WIDTH = 1536;
      const HEIGHT = 1024;
      const PADDING = 100; // generous horizontal margin
      const MAX_TEXT_WIDTH = WIDTH - PADDING * 2;

      // Use FULL title in uppercase -- no truncation. Word-wrap + shrink font to fit.
      const displayTitle = title.toUpperCase();

      const MAX_LINES = 3;
      const words = displayTitle.split(/\s+/);

      // Try font sizes from large to small, pick the largest that fits within MAX_LINES
      const fontCandidates = [80, 68, 58, 50, 44, 38, 32];
      let fontSize = 38;
      let lines = [];

      for (const fs of fontCandidates) {
        // Bold uppercase: ~0.62 character width ratio for Impact/Arial Black
        const charsPerLine = Math.floor(MAX_TEXT_WIDTH / (fs * 0.62));
        const testLines = [];
        let currentLine = '';

        for (const word of words) {
          const candidate = currentLine ? `${currentLine} ${word}` : word;
          if (candidate.length > charsPerLine && currentLine) {
            testLines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = candidate;
          }
        }
        if (currentLine) testLines.push(currentLine);

        if (testLines.length <= MAX_LINES) {
          fontSize = fs;
          lines = testLines;
          break;
        }
      }

      // If even smallest font doesn't fit, word-wrap at smallest and take first MAX_LINES
      if (lines.length === 0) {
        const charsPerLine = Math.floor(MAX_TEXT_WIDTH / (32 * 0.62));
        let currentLine = '';
        for (const word of words) {
          const candidate = currentLine ? `${currentLine} ${word}` : word;
          if (candidate.length > charsPerLine && currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = candidate;
          }
        }
        if (currentLine) lines.push(currentLine);
        fontSize = 32;
        lines = lines.slice(0, MAX_LINES);
      }

      const lineHeight = Math.round(fontSize * 1.3);
      const textBlockHeight = lines.length * lineHeight;

      // Position text near the bottom
      const startY = HEIGHT - textBlockHeight - 50;

      const textElements = lines.map((line, i) => {
        const y = startY + i * lineHeight + fontSize;
        return [
          // Black stroke for outline
          `<text x="${WIDTH / 2}" y="${y}" text-anchor="middle"`,
          `  font-family="Arial Black, Impact, Helvetica, sans-serif"`,
          `  font-size="${fontSize}" font-weight="900"`,
          `  stroke="#000000" stroke-width="7" fill="#000000"`,
          `  paint-order="stroke">${this._escapeXml(line)}</text>`,
          // White fill on top
          `<text x="${WIDTH / 2}" y="${y}" text-anchor="middle"`,
          `  font-family="Arial Black, Impact, Helvetica, sans-serif"`,
          `  font-size="${fontSize}" font-weight="900"`,
          `  fill="#FFFFFF">${this._escapeXml(line)}</text>`,
        ].join('\n');
      }).join('\n');

      // Dark gradient covering bottom 45% -- fully opaque at bottom to hide any AI-generated text
      const gradientTop = Math.floor(HEIGHT * 0.50);
      const gradientHeight = HEIGHT - gradientTop;

      const svgOverlay = Buffer.from(`
        <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
              <stop offset="35%" stop-color="#000000" stop-opacity="0.65"/>
              <stop offset="70%" stop-color="#000000" stop-opacity="0.92"/>
              <stop offset="100%" stop-color="#000000" stop-opacity="1.0"/>
            </linearGradient>
          </defs>
          <rect x="0" y="${gradientTop}" width="${WIDTH}" height="${gradientHeight}" fill="url(#bg)"/>
          ${textElements}
        </svg>
      `);

      const outputPath = imagePath.replace(/\.png$/, '_final.png');
      await sharp(imagePath)
        .composite([{ input: svgOverlay, top: 0, left: 0 }])
        .png()
        .toFile(outputPath);

      this.logger.info('Text overlay applied to thumbnail');
      return outputPath;
    } catch (error) {
      this.logger.warn('Text overlay failed, using raw thumbnail:', error.message);
      return imagePath;
    }
  }

  _escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };