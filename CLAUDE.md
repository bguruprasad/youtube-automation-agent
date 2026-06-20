# YouTube Automation Agent — Repo Knowledge

## Overview

This repository is a Node.js-based automated YouTube content generation system. It is designed to take a topic and produce a full video package including:
- AI-generated script
- Visual assets / images
- TTS narration
- Assembled video
- Thumbnail
- Captions
- SEO metadata

The goal is revenue-driven automated content creation with a single express server interface.

## Context Navigation (knowledge graph first)

When you need to understand the docs or project content:
1. ALWAYS query the knowledge graph first: `/graphify query "your question"`
2. Only read raw files if the user explicitly says "read the file" or "look at the raw file"
3. The graph lives in `graphify-out/` (`graph.json`, `GRAPH_REPORT.md`). Rebuild after doc edits
   with `/graphify --update`. graphify runs on **python3.11** (system python3 is too old); the
   pinned interpreter is in `graphify-out/.graphify_python`.

## Core Architecture

- `index.js` — Main entrypoint and Express server on port `3456`
- `agents/` — Modular GPT-powered components for content, scripts, thumbnails, SEO, production, publishing, analytics
- `utils/` — Shared services: AI video generation, credential management, logging
- `database/db.js` — SQLite schema and persistence layer (DB file: `data/youtube_automation.db`). NOTE: the real path is `database/db.js` (older docs sometimes called it `utils/database.js`).
- `public/index.html` — Web dashboard UI (dark theme). There is also a separate `dashboard/index.html`.
- `output/` — Generated run folders with final assets (`output/<date>_<title-slug>/`)
- `config/credentials.json` — Stored API credentials (`config/credentials.example.json` is the template)
- `data/` — Local generated assets, inputs, the SQLite DB, and production files
- `logs/` — Per-component Winston logs (`logs/*.log`)
- `schedules/daily-automation.js` — Daily cron automation scheduler
- YouTube OAuth helper scripts (standalone, run manually to acquire tokens): `authenticate.js`, `modern-auth.js`, `oauth-server.js`, `simple-auth.js`. These are alternative OAuth flows using `googleapis`; publishing is optional and untested with real creds.
- `mcp/content-strategy-agent.mcp.json` — MCP config for the content strategy agent

## Pipeline Flow

1. `/generate` receives a topic
2. `ContentStrategyAgent` builds a strategy and chooses an angle
3. `ScriptWriterAgent` writes a script with sections and visuals instructions
4. `ThumbnailDesignerAgent` builds a thumbnail concept and image
5. `SEOOptimizerAgent` generates title, description, tags, chapters, and score
6. `ProductionManagementAgent` processes the content:
   - saves script
   - generates audio via TTS
   - generates visuals
   - assembles video with ffmpeg
   - creates captions
7. `PublishingSchedulingAgent` queues uploads to YouTube if credentials present
8. `AnalyticsOptimizationAgent` tracks and surfaces analytics

## Important Files

- `README.md` — usage instructions and setup notes
- `package.json` — dependencies and npm scripts
- `setup.js` — environment and credential setup wizard
- `utils/ai-video-generator.js` — AI image + TTS + video assembly logic with fallback paths
- `utils/credential-manager.js` — credential loading and YouTube/OpenAI setup
- `database/db.js` — DB initialization, tables, and save/load methods
- `agents/production-management-agent.js` — output folder creation and production orchestration
- `agents/content-strategy-agent.js` — YouTube trend/competitor analysis and topic selection
- `agents/script-writer-agent.js` — script generation and fallback template logic
- `agents/thumbnail-designer-agent.js` — thumbnail concept generation and sharp-based artwork
- `agents/seo-optimizer-agent.js` — SEO metadata generation and scoring
- `agents/publishing-scheduling-agent.js` — YouTube upload scheduling and publish queue

## APIs

- `GET /` — dashboard
- `GET /health` — health status
- `GET /suggest?niche=X&count=5` — topic suggestions
- `POST /generate` — start generation
- `GET /outputs` — list generated output folders
- `GET /output/:folder/:file` — fetch specific output file
- `GET /analytics` — channel summary from in-memory reports (legacy; reads `analytics_reports` DB rows, which are only written by the daily job analyzing `publish_schedule` `published` rows — currently empty since dashboard uploads don't create those rows)
- `GET /analytics/videos` — **per-video report for dashboard uploads** (`AnalyticsOptimizationAgent.getUploadedVideosReport()`): scans `output/**/youtube_upload.json` markers, batch-fetches live YouTube stats (`youtube.videos.list`, 50 ids/call), merges with `script.json` cost → views/likes/comments + **cost-per-view**. Powers the dashboard **Analytics tab**. Works without the daily job; degrades to markers-only if the YT API isn't configured.
- `GET /strategy-review` (last persisted) + `POST /strategy-review/generate` — **real weekly strategy review** (`generateStrategyReview()`): derives deterministic patterns from `getUploadedVideosReport()` (Shorts-vs-long avg views, best/worst, cost-per-view) + LLM (`gpt-4o-mini`) recommendations on what to make more of. Persists to `data/strategy-review.json`. Shown in the dashboard **Analytics tab → Strategy Review**. The Sunday `weekly-strategy-review` cron now calls this (was previously a no-op that logged canned strings to `automation_events` and processed empty data).
- `GET /schedule` — schedule info
- `POST /publish/:contentId` — publish scheduled content

## Technical Details (verified)

### Models & Cost (~$0.20–0.30 per run)
- Image gen: `gpt-image-1` (NOT dall-e-3), ~$0.04/image × 5 images = ~$0.20
- TTS: OpenAI `tts-1`, voice `onyx`, ~$0.06. 4096-char limit handled by sentence-boundary chunking; chunks concatenated with ffmpeg.
- Text: `gpt-4o-mini`, negligible cost.
- **Per-run cost metering** (`utils/cost-meter.js`): a `CostMeter` is attached to
  `production.aiVideoGenerator.costMeter` at the start of each `/generate`,
  `/generate-short`, `/short-from` run. The generator records each billable call
  (image by size×quality, OpenAI TTS by char, LLM by token; ElevenLabs counted as
  credits, $0). The summary is persisted into the run's `script.json` as `cost`
  (+ a `meta` block: resolution, duration, models, image count). `/outputs` and
  `/shorts` surface both; the dashboard shows them via an ⓘ button → info modal.
  Rates in `cost-meter.js` are approximate published prices — update RATES when
  they change.
- **Backfill for old folders** (`scripts/backfill-costs.js` + `estimateFromFolder`
  in `cost-meter.js`): reconstructs estimated cost for folders generated before
  metering, from on-disk assets (counts `assets/*.png` >1KB so placeholder images
  from simulation fallbacks aren't billed; thumbnail; `script_tts.txt` length).
  Writes `cost` (with `backfilled:true`) + `meta` into script.json. Dry-run by
  default; `--apply` writes; `--force --apply` re-estimates folders that already
  have a *backfilled* cost (never overwrites a live-metered run). Dashboard tags
  these "(est)". Long videos backfill ~$0.58–0.73, Shorts ~$0.04–0.05 (NOTE: this
  is higher than the old "~$0.20–0.30/run" estimate above — that figure used a
  rougher $0.04/image; the meter uses real gpt-image-1 size×quality rates).

### Video Assembly (in `utils/ai-video-generator.js`)
- Output: 1920×1080, 30fps, with audio.
- 4 random styles per video for variety: `ken-burns`, `cinematic`, `clean`, `dynamic`. Ken Burns uses zoompan (zoom in/out, pan L/R).
- Per-section duration is weighted by content length (not equal splits). Fade in/out (0.5s) between sections; transitions are currently hard cuts (xfade crossfade is a TODO).
- **ffmpeg `drawtext` is UNAVAILABLE** in the local brew build (no `--enable-libfreetype`). Section title text is burned onto images via sharp SVG instead. Do not reach for `drawtext`.

### Thumbnails
- AI image generated with an aggressive no-text prompt (the model otherwise renders garbled text). Title text is then overlaid via sharp SVG: adaptive font sizing (80px→32px), 100px margins, gradient bar.

### Known Bugs / Risks
- `Content saved with ID: undefined` — DB insert returns undefined ID.
- gpt-image-1 image failures now handled in `generateVisualAssets` (`utils/ai-video-generator.js`): `_withRetry()` does exponential backoff on 429/5xx; a `400` "rejected by the safety system" triggers ONE retry with `_safeFallbackPrompt()` (strips possessives/hype words → generic football scene). Real-person + stylized titles (e.g. "Messi's Magic: The Solo Sensation") were tripping safety → silent placeholder; now they recover. If images still can't be made, `generateSlideshowVideo` builds a **title-card video** via sharp (NOT drawtext) instead of writing a `video.mp4.info` stub — so a run always yields a playable mp4.
- Daily cron runs but full daily *content-generation* automation hasn't been end-to-end verified.
- **Automation is now OFF by default** (persisted DB setting `automation_enabled`, unset=disabled). The cron timers always start, but a `this.isEnabled` gate blocks the work until enabled. Managed from the dashboard **Schedule tab** (`GET /automation`, `POST /automation/toggle {enabled}`, `POST /automation/run/:task` to run one task now). Task metadata (cron + label + runner) lives in `DailyAutomation.taskMeta`; `getAutomationStatus()` returns per-task cron/nextRun/lastRun. Enabling it lets the 6 AM job generate AND publish (PUBLIC) unattended — warn before enabling.
- YouTube publishing OAuth not configured; `publishing-scheduling-agent.js` untested with real creds.

### Top Priorities
1. Video quality: crossfade (xfade) transitions, background music, intro/outro cards.
2. Image reliability: retry/backoff for 429s.
3. YouTube publishing: wire up OAuth (`YOUTUBE_CLIENT_ID`/`YOUTUBE_CLIENT_SECRET`), test upload flow.

## Dependencies

Declared in `package.json`: `@google/generative-ai`, `axios`, `chalk`, `cron`, `dotenv`, `express`, `form-data`, `googleapis`, `inquirer`, `node-cron`, `openai`, `playwright`, `replicate`, `sharp`, `winston`.

`sqlite3` is `require()`d in `database/db.js` (`require('sqlite3').verbose()`) and IS listed in `package.json` (`^5.1.6`, installed `5.1.7`). (Earlier docs claimed it was missing — that was stale; verified present 2026-06-20.)

## Environment / Setup Notes

- Requires Node.js `>= 18`
- Requires `ffmpeg` installed on the machine
- `OPENAI_API_KEY` is expected in `.env` or `config/credentials.json`
- YouTube OAuth credentials are optional; publishing is disabled if not configured
- `npm install` to install dependencies
- Start server with `npm start` or `node index.js`

## Known Status and Risks

- The repo is forked from `bguruprasad/youtube-automation-agent`
- The current branch is ahead of origin with multiple commits and custom improvements
- Video production uses ffmpeg and may rely on available system codecs
- Thumbnail generation uses `sharp` and can fallback to placeholders if sharp is missing
- TTS: ElevenLabs is tried FIRST if `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` are set (higher quality), otherwise falls back to OpenAI `tts-1`/`onyx`
- Publishing requires valid YouTube OAuth tokens and may not be fully verified

## Recommended Next Checks

- Confirm `config/credentials.json` and `.env` are populated
- Verify `ffmpeg` is installed and accessible
- Inspect `schedules/daily-automation.js` for actual automation behavior
- Validate whether the `/generate` endpoint currently assembles real video or falls back to simulated outputs

---

Generated by a repo summary process to help future sessions understand key structure and behavior quickly.
