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

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);
    
    try {
      if (!this.openai) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      
      // Use gpt-image-1 (current OpenAI image model)
      const params = {
        model: "gpt-image-1",
        prompt: enhancedPrompt,
        n: 1,
        size: "1536x1024", // landscape for video
        quality: "medium"
      };
      const response = await this.openai.images.generate(params);

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

  async generateVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Generating video from assets...');
    
    try {
      // Try Replicate for video generation first
      if (this.replicate && this.replicate.auth) {
        return await this.generateReplicateVideo(script, visualAssets, audioPath, outputPath);
      }
      
      // Fallback to simple slideshow with Playwright
      return await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
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

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating dynamic video with ffmpeg...');

    const duration = this.calculateScriptDuration(script);
    const { execSync } = require('child_process');
    const fsSync = require('fs');

    // Filter to actual image files
    const validAssets = visualAssets.filter(a => {
      try { return fsSync.existsSync(a) && fsSync.statSync(a).size > 1000; } catch { return false; }
    });

    const videoPath = outputPath.replace('.mp4', '_visual.mp4');
    const tempDir = path.join(path.dirname(outputPath), '.tmp_video');
    await fs.mkdir(tempDir, { recursive: true });

    if (validAssets.length === 0) {
      this.logger.warn('No valid visual assets, generating placeholder video');
      const safeTitle = (script.title || 'Video').replace(/'/g, "\\'").replace(/:/g, '\\:');
      const cmd = `ffmpeg -y -f lavfi -i "color=c=0x1a1a2e:s=1920x1080:d=${duration}" ` +
        `-vf "drawtext=text='${safeTitle}':fontsize=54:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:fontfile=/System/Library/Fonts/Helvetica.ttc" ` +
        `-c:v libx264 -pix_fmt yuv420p "${videoPath}"`;
      execSync(cmd, { stdio: 'pipe', timeout: 60000 });
    } else {
      // Calculate per-section durations from script
      const sectionDurations = this._getSectionDurations(script, duration, validAssets.length);
      
      // Pick a random video style for variety
      const videoStyle = this._pickVideoStyle();
      this.logger.info(`Video style: ${videoStyle.name}`);

      // Generate individual clips with effects per section
      const clipPaths = [];
      for (let i = 0; i < validAssets.length; i++) {
        const clipPath = path.join(tempDir, `clip_${i}.mp4`);
        const clipDuration = sectionDurations[i] || Math.floor(duration / validAssets.length);
        const sectionTitle = this._getSectionTitle(script, i);
        
        // Build the Ken Burns / fade filter that operates on the raw image.
        const filter = this._buildClipFilter(i, validAssets.length, clipDuration, sectionTitle, videoStyle);

        // Generate a full-frame transparent text overlay and composite it AFTER
        // zoompan via ffmpeg overlay, so the title is never cropped by the zoom.
        const textOverlay = await this._makeTextOverlay(sectionTitle, tempDir, i);

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
            ? `-filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30[bg];[bg][1:v]overlay=0:0:format=auto"`
            : `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30"`;
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

    // Add audio
    let finalPath = videoPath;
    if (audioPath) {
      try {
        if (fsSync.existsSync(audioPath) && fsSync.statSync(audioPath).size > 100) {
          await this.addAudioToVideo(videoPath, audioPath, outputPath);
          try { await fs.unlink(videoPath); } catch {}
          finalPath = outputPath;
        }
      } catch {}
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
  _buildClipFilter(index, totalClips, clipDuration, sectionTitle, style) {
    const filters = [];
    const fps = 30;
    const totalFrames = clipDuration * fps;

    // Scale to fit 1920x1080
    filters.push('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black');

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
      const directions = [
        // Slow zoom in (centered) - starts at full frame, text visible at start
        `zoompan=z='min(${zoomIn},${zMax})':d=${totalFrames}:x='${cx}':y='${cy}':s=1920x1080:fps=${fps}`,
        // Slow zoom out (centered) - ends at full frame
        `zoompan=z='max(${zoomOut},1.0)':d=${totalFrames}:x='${cx}':y='${cy}':s=1920x1080:fps=${fps}`,
        // Gentle pan left->right at a fixed modest zoom
        `zoompan=z='1.06':d=${totalFrames}:x='(iw-iw/zoom)*on/${totalFrames}':y='${cy}':s=1920x1080:fps=${fps}`,
        // Gentle pan right->left at a fixed modest zoom
        `zoompan=z='1.06':d=${totalFrames}:x='(iw-iw/zoom)*(1-on/${totalFrames})':y='${cy}':s=1920x1080:fps=${fps}`,
      ];
      filters.length = 0; // zoompan handles scaling
      filters.push(directions[index % directions.length]);
    }

    // Fade in (first 0.5s) and fade out (last 0.5s)
    filters.push(`fade=in:0:${Math.min(15, totalFrames)},fade=out:${Math.max(0, totalFrames - 15)}:15`);

    filters.push(`fps=${fps}`);
    return filters.join(',');
  }

  /**
   * Build a full-frame (1920x1080) TRANSPARENT PNG containing just the section
   * title in a lower-third bar. This is composited over the clip AFTER zoompan
   * (via ffmpeg overlay), so the text is never cropped/zoomed by Ken Burns.
   * Returns the overlay path, or null if sharp is unavailable / no title.
   */
  async _makeTextOverlay(sectionTitle, tempDir, index) {
    if (!sharp || !sectionTitle) return null;

    try {
      const W = 1920;
      const H = 1080;
      const fontSize = 52;
      // Keep the text band well inside a "title-safe" area (~7% margin from the
      // bottom edge) so it reads cleanly on all displays.
      const bandHeight = 160;
      const bandTop = H - bandHeight - 60;   // 60px above the very bottom
      const textY = bandTop + bandHeight / 2 + fontSize / 3;
      const safeTitle = this._escapeXml(
        sectionTitle.length > 60 ? sectionTitle.slice(0, 57) + '...' : sectionTitle
      );

      const svgOverlay = Buffer.from(`
        <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
              <stop offset="100%" stop-color="#000000" stop-opacity="0.78"/>
            </linearGradient>
          </defs>
          <rect x="0" y="${bandTop}" width="${W}" height="${bandHeight + 60}" fill="url(#bg)"/>
          <text x="${W / 2}" y="${textY}" text-anchor="middle"
            font-family="Arial Black, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
            stroke="#000000" stroke-width="5" fill="#000000" paint-order="stroke">${safeTitle}</text>
          <text x="${W / 2}" y="${textY}" text-anchor="middle"
            font-family="Arial Black, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
            fill="#FFFFFF">${safeTitle}</text>
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
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
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
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
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
      
      const response = await this.openai.images.generate({
        model: "gpt-image-1",
        prompt: prompt,
        n: 1,
        size: "1536x1024",
        quality: "high"
      });

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