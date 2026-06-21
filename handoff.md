# YouTube Automation Agent — Session Handoff

> Context handoff for the next agent. Verify time-sensitive facts against git log, YouTube, and the working tree before relying on it. Authoritative technical reference is **CLAUDE.md** (committed).

## Project
Node.js automated YouTube pipeline for a **football channel** ("Halftime Replay"). Topic/match → strategy → script → gpt-image-1 images → OpenAI TTS (tts-1-hd) → ffmpeg video → thumbnail → captions → SEO → optional YouTube upload. Express server on **port 3456**, dashboard `public/index.html` (self-contained, no CDN). Repo: `/Users/guru/Work/youtube-automation-agent`, branch `master`. Generated media lives **outside the repo** at `OUTPUT_DIR` (currently `/Users/guru/Work/halftime-replay-output`, with `longs/` + `shorts/` subdirs).

## Hard rules (follow exactly)
- **Commit only when the user asks** (they say "proceed/yes" = OK to commit/push as you go). **Always push** when they ask, per standing instruction this session. End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **One task at a time** for multi-step work — the user asked to confirm before each step. Use TodoWrite.
- **Never commit secrets.** `.env`, `config/credentials.json`, `config/tokens.json` are gitignored. `.env` contains the OpenAI key, Google client secret, and the `FOOTBALL_DATA_API_KEY` — scan diffs for `GOCSPX`/`sk-proj`/`refresh_token`/the football-data key before committing. (Rotation eventually recommended — these appeared in chat historically.)
- **Restart the server after code changes** — it serves stale code: `lsof -ti:3456 | xargs kill; node index.js`. Dashboard HTML edits are live without restart (served from disk).
- **Uploads can be PUBLIC.** `DEFAULT_PRIVACY_STATUS=public` AND `wc_upload_privacy=public` — the World Cup task auto-publishes match videos PUBLICLY to the live channel. Be careful.
- graphify: query the knowledge graph before deep file reads; runs on **python3.11** (`graphify-out/.graphify_python`). On `--update`, SCOPE TO SOURCE ONLY — exclude `output/`/`data/` (hundreds of generated images/videos) or it tries to Whisper/vision-extract them. Semantic-extraction subagents use `model="sonnet"`.

## Infra / external state
- **YouTube channel "Halftime Replay"** (`UCBQvgoqx1_CRqxa3pYGB_og`), football niche, phone-verified. OAuth token in `config/tokens.json` has `youtube.force-ssl` (needed for comment replies) + upload + analytics scopes. Re-auth: `rm config/tokens.json && node oauth-server.js` (port 8080) → consent URL.
- **OpenAI**: funded/working. **football-data.org**: key SET (`FOOTBALL_DATA_API_KEY`) → World Cup match videos are LIVE.
- **YouTube Analytics API**: enabled in Google Cloud project 903576929195 (user enabled it this session) → watch-hours work.
- **Automation is ON** (`automation_enabled=true`). Live task state: `daily-content-generation` DISABLED (`disabled_tasks`); ON = daily-shorts (7am, `daily_shorts_count=2`), worldcup-match-videos (every 30min, auto-upload PUBLIC), comment-engagement (every 2h, drafts only), publish-queue, analytics, optimization, db-maintenance. **The server must stay running** for cron to fire (in-process scheduler).
- **External output dir** `/Users/guru/Work/halftime-replay-output/{longs,shorts}` — generated media. `.env` `OUTPUT_DIR` points here (not committed).

## Shipped this session (all committed + pushed to origin/master; 0 unpushed)
Latest first: `8ecd456` generated_content index → dashboard source for /outputs & /shorts · `c3d82b9` split output into longs/+shorts/ · `c2e7ddc` OUTPUT_DIR configurable (media out of repo) · `969c112` Costs dashboard tab (SVG chart) · `75b56a5` cost ledger · `634b136` audience engagement engine · `7ca9a34` analytics reorder · `96eaeb8` scoreboard layout refine · `cd9e923` live privacy sync + dedup shorts · `578ed0f` dup-upload guard · `a99f2f6` tag-rejection fix + match SEO · `a14c625`/`d7e1eee`/`15414af` World Cup match videos (recap+Short, scoreboard, 30-min polling).
- **Live test uploads on the channel** (unlisted/public): Germany 2-1 Ivory Coast Short `SDYQFfFK128` (now unlisted).

## Codebase facts the next agent needs
- **Paths**: `utils/paths.js` is the single source of truth — `baseRoot()`=OUTPUT_DIR, `outputRoot()`=`<base>/longs`, `shortsRoot()`=`<base>/shorts`. Default (unset) = `<repo>/output`. Never hardcode output paths.
- **Content index**: `generated_content` DB table is the source of truth for WHICH videos exist (folder PK, type long|short|match_recap, title). `/outputs` + `/shorts` list from it, then enrich each from the folder via `app._enrichFolder()` (cost/meta/files/upload status NOT duplicated in DB → no drift). Recorded via `db.upsertContent()` at every generation site. Backfill: `scripts/backfill-content-index.js`.
- **Cost**: per-run `CostMeter` → persisted into each `script.json`; daily `cost_ledger` table (`db.recordCost`, idempotent by ref) → `GET /costs/daily` → 💰 Costs tab. `_ledgerFolderCost()` records at each generation site.
- **World Cup**: `utils/worldcup-provider.js` (football-data.org WC, rate-limit-header aware, cache-first crests in `data/crests/`). `app.generateMatchVideos()` builds long recap + Short with `_makeScoreboardOverlay()` (crests+score, in `ai-video-generator.js`). Scheduler `runWorldCupMatchVideos()` seen-guard = `wc_processed_match_ids`.
- **Comments**: `utils/comment-engine.js` — classify+draft replies into `comment_queue` (review-first, never auto-posts). Reply works; **heart/pin NOT in YouTube Data API v3**.
- **Uploads**: `PublishingSchedulingAgent.uploadOutputFolder(folderPath,{privacyStatus,force})` — marker-guard against dupes; `_sanitizeTags()` drops tags >30 chars (YouTube rejects long tags); `_privacyOverride` beats env default.
- **ffmpeg `drawtext` unavailable** (no libfreetype) → all text via sharp SVG overlays.

## Open follow-up work
- **Admin analytics graphs** are the natural next build — the data substrate is ready (`cost_ledger` via `/costs/daily`, `generated_content` index). 💰 Costs tab exists; more admin views could read these.
- **Auto-post for comment replies** — deferred by user; currently review-only. Add a toggle when trusted.
- **Legacy `productions` table** still has the `Content saved with ID: undefined` bug — superseded by `generated_content` for listing; don't rely on it.
- daily-shorts "recent moment" can overlap the WC match task (same match, different framing) — user aware; could disable daily-shorts if redundant.

## Known issues / notes
- World Cup task acts only on matches finishing AFTER it starts (seen-guard baselines existing); already-played matches won't backfill — use `POST /generate-match {matchId}` manually.
- Recaps are STYLIZED (AI scene + scoreboard + factual narration), not real highlight footage (copyright).
- Background `node index.js` leaves exit-143 on kill — harmless.

## Immediate next step
Branch `master`, clean except this session's doc changes being committed (README rewrite, SHORTS_PLAN.md + jcode.md deleted, this handoff). Server running on 3456, automation ON. **Most useful next:** build the admin analytics dashboard (daily spend + content trends) on top of `/costs/daily` + `generated_content` — that's where the user is heading. Or review the comment-engagement queue (💬 Engagement tab) and consider enabling auto-post once draft quality is trusted.
