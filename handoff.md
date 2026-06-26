# YouTube Automation Agent — Session Handoff

_Last updated: 2026-06-27. Authoritative technical reference is **CLAUDE.md** (committed). Verify time-sensitive facts (git log, YouTube, working tree) before relying on this._

## Project
Node.js automated YouTube pipeline for a **football channel** ("Halftime Replay"). Moment/match → script → images (Flux 2 Pro via Replicate, gpt-image-1 fallback) → OpenAI TTS → ffmpeg video → SEO → optional/auto YouTube upload. Express on **port 3456**, dashboard `public/index.html` (self-contained). Branch `master`. Generated media lives OUTSIDE the repo at `OUTPUT_DIR` = `/Users/guru/Work/halftime-replay-output/{longs,shorts}` — resolve with `node -e "require('dotenv').config(); console.log(require('./utils/shorts-config').outputDir)"`, never assume `<repo>/output`.

## Repo / remotes
- `origin` = `bguruprasad/youtube-automation-agent` (the user's fork — **ALL work pushes here**).
- `upstream` = `darkzOGx/youtube-automation-agent` (original). **DO NOT merge.** Reviewed this session: upstream has only 4 real non-merge commits ahead (2 are README marketing junk; 2 touch code — "v2.0 model bumps" and "multi-provider text service"). Both code ones are low-benefit + high conflict risk against our heavily-modified `ai-video-generator.js`. User decided to **ignore upstream**. Remote kept for reference only.

## Current state (verified at handoff)
- Working tree **clean**, in sync with origin (0/0).
- **Server UP** on 3456. Restart after code changes: `lsof -ti:3456 | xargs kill; nohup node index.js > /tmp/yt-server.log 2>&1 &` (dashboard HTML edits are live without restart).
- **Automation ON.** Key DB settings: `automation_enabled=true`, `stock_clips_enabled=true`, `stock_clips_mode=mix`, `wc_upload_privacy=public`, `daily_shorts_privacy=public`, `daily_shorts_count=2`.
- Channel: **Halftime Replay** (`UCBQvgoqx1_CRqxa3pYGB_og`), ~40 subs / 62 videos / ~14k views.

## SECURITY (must persist)
- NEVER commit secrets. Gitignored: `.env`, `config/credentials.json`, `config/tokens.json`, `data/crests/`, `data/stock-clips/`.
- Scan every diff for: `sk-proj`, `GOCSPX`, `refresh_token`, `ya29`, `r8_` (Replicate), the football-data key, `API_FOOTBALL_KEY`, `PEXELS_API_KEY`, any 32-hex blob.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Standing instruction: **commit + push without asking** (after the scan). Memory `always-commit.md`.

## OAuth — was the big blocker today, now FIXED
- Refresh token EXPIRED 2026-06-26 → `invalid_grant` on all uploads (manual + auto). Cause: OAuth app in **"Testing"** mode = 7-day refresh-token life.
- FIX: user **PUBLISHED the app to Production** (Google Cloud → OAuth consent screen → PUBLISH APP) → `refresh_token_expires_in` now ABSENT = no more 7-day expiry. Re-authed via **`node oauth-server.js`** (port 8080, registered redirect `http://localhost:8080/auth/callback`). NOTE: `modern-auth.js` gives `redirect_uri_mismatch` — use oauth-server.js. New token verified live (channels.list OK), has `youtube.force-ssl` + upload + analytics scopes.
- If `invalid_grant` recurs: `node oauth-server.js` → open printed URL → authorize ("unverified app" → Advanced → Go to (unsafe) is normal) → restart main server to load new `config/tokens.json`. (oauth-server auto-launches a 2nd app instance after saving the token → port-3456 collision error, harmless; token already saved.)

## What shipped THIS session (committed + pushed, newest first)
- `95118c7` Dashboard: Short idea tiles fully clickable to toggle selection.
- `ec8092d` Hook: skip text hook on recaps (scoreboard IS the hook; was colliding).
- `5fa5c92` Fix: first-frame hook renders on CARD scenes too (cards are default; hook was being discarded → most Shorts had no hook).
- `b7f6afe` Shorts hook: bold first-frame text hook + punchier spoken hook.
- `bdcf4cd` Shorts SEO: purpose-built (LLM hooky title, real entity tags, fan hashtags) — replaced junk tutorial-template SEO.
- `4ceaf9c` Daily Shorts auto-upload (public).
- `c56ad8c` Dashboard: fix "Created undefined" + collapsible queue.
- `000afca` DB-persisted generation queue (serialize heavy renders).
- `3946808` Skip wasted thumbnail upload for Shorts.
- `c992322` Card is the default scene treatment.
- `11b0ae2` Dashboard Copy-button fix.
- `9f3d1ef` Fix clip-scene ffmpeg timeout + silent audio-drop.

## Key systems added/finalized today
- **Generation queue** (`utils/generation-queue.js` + `generation_queue` table): single-worker FIFO, DB-persisted, `GEN_QUEUE_DELAY_MS` (default 8s) between jobs. Serializes short/match_recap/wc-match so concurrent ffmpeg/Flux don't thrash the box (that caused 15-min render timeouts → silent fallback to plain stills). Runners in `index.js _registerQueueRunners()`. `/generate-short` & `/generate-match` return `{queued,jobId}`. Cron tasks ENQUEUE. `GET /queue` + Schedule-tab widget. Resumes on restart.
- **Stock clips (Pexels)**: `utils/pexels-provider.js` cache-first + **brightness-aware** (rejects dark clips: `PEXELS_STRICT_BRIGHTNESS=true`, `PEXELS_MIN_BRIGHTNESS=70`, `PEXELS_PROBE_N=4`), stadium-biased queries. Per-scene routing (`_resolveSceneVisuals`): **card** (default; 82% still over blurred clip, `STOCK_CARD_WIDTH_PCT=0.82`, `STOCK_BG_BLUR=10`, `STOCK_BG_DIM=0.12`), **clip** (pure-crowd), **still** (no clip). ffmpeg uses **bounded `-stream_loop`** (not `-1`!) + `_withRenderRetry` + `-an` on scene clips (audio muxed at end, `_hasAudioStream` verifies). Needs `PEXELS_API_KEY` (set). `IMAGE_PROVIDER=flux` (set).
- **Hook system** (`hookText` on short scripts): daily/manual Shorts get a bold yellow first-frame hook (`_mergeHookOverlay`, sharp) on all scene types; recaps skip it (scoreboard is the hook). Opt-out `SHORTS_HOOK_OVERLAY=false`. Spoken hook prompt rewritten (no "witness the magic" warm-up).
- **Shorts SEO** (`utils/shorts-producer.js buildShortSeo`): LLM title (gpt-4o-mini ~$0.0002) + `_extractEntities` → real tags/hashtags. NO tutorial/list junk. Recap SEO (`index.js _buildMatchSeo`) already clean + team hashtags.

## Two automated upload paths (BOTH auto-upload PUBLIC)
- `worldcup-shorts` (hourly): recap Short per NEW finished WC match (score cross-checked vs API-Football), auto-upload at `wc_upload_privacy`. Enqueues `wc-match`.
- `daily-shorts-generation` (7 AM): `daily_shorts_count` Shorts from moments, auto-upload at `daily_shorts_privacy`. Enqueues `short` w/ `autoUpload:true`.
- Manual dashboard "Generate Short" does NOT auto-upload (draft for review).
- `daily-content-generation` (long video) is DISABLED (`disabled_tasks`).

## Parked TODOs (memory/)
- `todo-real-player-likeness.md`: Flux inconsistent on specific celebrity faces; genuine model limit, not a bug.
- `todo-flux-net-goalpost.md`: net sometimes renders past the posts; prompt guardrail added, UNVERIFIED on a real goal.
- Lazy still-generation (deferred): card scenes always make the Flux still even when unused; minor cost.
- **Dev-cost tracking (discussed, NOT built)**: user wanted a choke-point wrapper around `require('openai')`/`require('replicate')` to log ALL API spend (incl. ad-hoc dev calls) tagged by source into an `api_spend` table + dashboard view; also reclassify deleted-test ledger rows as 'dev'. Pick up here if asked.

## Next ideas (not started)
- Watch `GET /analytics/videos` over the next days to see if hook+SEO move views/retention.
- Remaining hook levers: hold hook longer on multi-scene Shorts; faster cold-open (smaller gains).

## Pointers
- `CLAUDE.md` = authoritative tech reference. Knowledge graph: `/graphify query "..."` (scope SOURCE only, python3.11).
- Memory: `~/.claude/projects/-Users-guru-Work-youtube-automation-agent/memory/MEMORY.md`.
- Videos uploaded this session (public): Beckham `_I1R_3R7Gdo`, Senegal `YHifT05cHnQ`, France `FFDHETj7uow`, England `sXAnyOSwOkk`, Iniesta `UUYUHJqs2tY`, Portugal `0xirrrgTXWU`.
