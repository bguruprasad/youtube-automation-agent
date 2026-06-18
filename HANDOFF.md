# YouTube Automation Agent - Handoff Document

## Project Overview

Fully automated YouTube video generation pipeline. Takes a topic and produces a complete video package: script, AI images, TTS narration, video assembly, thumbnail, captions, and SEO metadata. Goal is revenue generation through automated YouTube content.

**Repo**: Forked from `bguruprasad/youtube-automation-agent`
**Branch**: `master` (17 commits ahead of origin)
**Stack**: Node.js, Express, OpenAI API (GPT-4o-mini + gpt-image-1 + TTS), ffmpeg, sharp, SQLite

## Architecture

```
index.js                    - Main entry point, Express server on port 3456
├── agents/
│   ├── content-strategy-agent.js    - GPT-powered topic/strategy generation
│   ├── script-writer-agent.js       - AI script writing with sections + visuals hints
│   ├── thumbnail-designer-agent.js  - Coordinates thumbnail generation
│   ├── seo-optimizer-agent.js       - SEO scoring and metadata
│   ├── production-management-agent.js - Orchestrates video production pipeline
│   ├── publishing-scheduling-agent.js - YouTube upload (not yet configured)
│   └── analytics-optimization-agent.js - Analytics tracking
├── utils/
│   ├── ai-video-generator.js       - Core: image gen, TTS, video assembly, thumbnails
│   ├── credential-manager.js       - API key management with getters
│   ├── database.js                 - SQLite storage
│   └── logger.js                   - Winston logging
├── public/
│   └── index.html                  - Web dashboard (dark theme)
└── output/                         - Generated content (per-run folders)
```

## Pipeline Flow

```
Topic → Strategy (GPT) → Script (GPT) → [Parallel: Thumbnail + SEO] → 
Visual Assets (5x gpt-image-1) → TTS Narration → Video Assembly (ffmpeg) → 
Captions (SRT) → Output Folder
```

Each run produces `output/<date>_<title-slug>/` containing:
- `script.json` - Full AI-generated script with sections
- `script_tts.txt` - Plain text for narration
- `thumbnail.png` - AI image + text overlay via sharp
- `narration.mp3` - TTS audio (chunked at 4096 chars, concatenated with ffmpeg)
- `video.mp4` - Final video (1920x1080, 30fps, with audio)
- `captions.srt` - Auto-generated subtitle file
- `assets/visual_N.png` - Section images

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard |
| `/health` | GET | Health check |
| `/suggest?niche=X&count=5` | GET | AI topic suggestions |
| `/generate` | POST | Trigger generation `{"topic": "..."}` |
| `/outputs` | GET | List generated content |
| `/output/:folder/:file` | GET | Serve generated files |
| `/schedule` | GET | Cron schedule info |
| `/analytics` | GET | Analytics data |

## Key Technical Details

### Image Generation
- Model: `gpt-image-1` (not dall-e-3, not mini)
- Cost: ~$0.04/image, 5 images per video
- Style presets: modern, cinematic, tech, lifestyle, minimalist
- Visual assets use script's `section.visuals` array for relevant prompts
- Thumbnails use aggressive no-text prompt (CRITICAL RULES in prompt)
- Thumbnail text overlay: sharp SVG with adaptive font sizing (80px->32px), 100px margins, gradient bar

### TTS / Audio
- OpenAI TTS with `tts-1` model, `onyx` voice
- 4096 char limit handled by sentence-boundary chunking
- Chunks concatenated with ffmpeg

### Video Assembly
- 4 random styles per video for variety: `ken-burns`, `cinematic`, `clean`, `dynamic`
- Ken Burns: zoompan effects (zoom in, zoom out, pan L/R) varying per section
- Per-section duration weighted by content length (not equal splits)
- Section title text burned onto images via sharp SVG (ffmpeg drawtext not available in this brew build)
- Fade in/out (0.5s) between sections
- ffmpeg does NOT have `--enable-libfreetype` so `drawtext` filter is unavailable

### Cost Per Run
- ~$0.20-0.30 total
- Images: ~$0.04 x 5 = $0.20
- TTS: ~$0.06
- GPT-4o-mini text: negligible

## Environment Setup

### Required
- `OPENAI_API_KEY` - Set in `.env` (with credits)
- `ffmpeg` - Installed via brew (needs libx264)
- `node` >= 18
- `npm install` (sharp, openai, express, sqlite3, etc.)

### Optional (not configured yet)
- `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` - For publishing
- YouTube OAuth is gracefully optional -- pipeline runs without it

### Running
```bash
node index.js          # Starts server on port 3456
# Dashboard: http://localhost:3456
# Cron: runs daily automatically
```

## What Works
- Full end-to-end pipeline: topic to finished video
- Web dashboard with suggest/generate/browse
- 4 videos successfully generated
- Dynamic video styles (Ken Burns, fades, section titles)
- Clean thumbnails with proper text overlay (no AI text in image)
- Organized output folders
- Daily cron automation

## What Needs Work (Priority Order)

### 1. Video Quality Enhancements
- **Crossfade transitions between sections** - Currently hard cuts between clips. ffmpeg `xfade` filter would make it smoother.
- **Background music** - Add royalty-free ambient music under narration
- **More video styles** - Split-screen, picture-in-picture, zoom-to-detail
- **Intro/outro cards** - Title card at start, subscribe CTA at end

### 2. Image Generation Reliability
- gpt-image-1 sometimes returns 429 rate limits
- Need exponential backoff retry logic (currently fails silently, falls back to placeholder)
- Consider parallel image generation with rate limiting

### 3. YouTube Publishing
- OAuth not configured -- needs `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`
- `publishing-scheduling-agent.js` exists but untested with real creds
- Need OAuth flow for token acquisition

### 4. Minor Bugs
- `Content saved with ID: undefined` - DB insert returns undefined ID
- ffmpeg `drawtext` filter unavailable (brew ffmpeg lacks freetype) - text overlays use sharp instead
- Cron scheduler runs but daily automation hasn't been end-to-end verified

### 5. Future Features
- A/B test thumbnails
- Analytics-driven topic selection
- Multi-channel support
- Video length variants (Shorts vs long-form)
- Voiceover style variety (different TTS voices per video)

## File Locations
- Logs: `logs/*.log` (per-component Winston logs)
- Database: `data/youtube_automation.db` (SQLite)
- Generated content: `output/<date>_<slug>/`
- Raw assets: `data/assets/`, `uploads/thumbnails/`
- Config: `.env`

## Recent Commits (newest first)
```
3166330 Remove blur/darken hack, use stronger no-text prompt instead
d4e1120 Thumbnail: blur+darken bottom 40% to destroy AI-generated text before overlay
a83c5e7 Thumbnail: wider margins (100px), fully opaque gradient to hide AI text
225cce8 Fix thumbnail: full title (no truncation), darker gradient hides AI text, stronger prompt
2c421fb Fix thumbnail text overflow + fix video generation (sharp text, no drawtext)
da913e3 Dynamic video generation: Ken Burns, per-section timing, text overlays, varied styles
4988ad9 Fix thumbnail text overflow: truncate at 60 chars, smaller fonts, max 3 lines
93dfee0 Fix NaN in estimated views display
ce70230 Improve image quality: better prompts, use script visual hints, modern style
2d90aca Add web dashboard with dark theme
bb27d46 Add /suggest and /outputs endpoints for interactive workflow
a3b1647 Fix thumbnail: pass actual script title instead of hardcoded 'Ethereal Dreamscript'
a8c8fce Organize output: per-run folders with all assets together
a70f4f7 Improve thumbnail generation: better prompt, gpt-image-1, sharp text overlay
01c19f2 Fix pipeline: gpt-image-1-mini, TTS chunking, ffmpeg video gen, graceful YouTube optional
0ea3e57 Fix critical issues across the codebase
3ea1b52 Initial commit: YouTube Automation Agent
```
