# 🎬 YouTube Automation Agent

An automated YouTube content pipeline for a **football/soccer channel** ("Halftime Replay").
Generates full video packages from a topic or a real match — script → AI images
(gpt-image-1) → TTS narration → ffmpeg video assembly → thumbnail → captions → SEO —
and can upload to YouTube. Single Express server with a web dashboard on port **3456**.

> This is a customized fork of `bguruprasad/youtube-automation-agent`. The authoritative,
> always-current technical reference is **[CLAUDE.md](CLAUDE.md)** — read that for deep detail.

---

## Quick start

```bash
npm install
cp config/credentials.example.json config/credentials.json   # add OpenAI + YouTube creds
# create .env with at least OPENAI_API_KEY (see "Configuration" below)
node index.js                                                 # http://localhost:3456
```

Requires **Node ≥ 18** and **ffmpeg** installed on the machine.

Restart the server after code changes — it serves stale code otherwise:
```bash
lsof -ti:3456 | xargs kill; node index.js
```

---

## What it does

| Capability | Notes |
|---|---|
| **Long videos** | Topic → strategy → script → 5 AI images → TTS → 1920×1080 video → thumbnail → captions → SEO |
| **Shorts** | Vertical 1080×1920 football moments; AI idea suggestions; optional auto-upload |
| **World Cup match videos** | Polls football-data.org every 30 min; per finished match generates a long recap **+** a Short with a scoreboard overlay (team crests + score), auto-uploads ~30 min after full-time |
| **Audience engagement** | Drafts factual, friendly replies to comments into a review queue (no auto-post) |
| **Cost metering** | Per-video cost (images/TTS/LLM) + a daily spend **cost ledger** by category |
| **Analytics** | Live per-video views/likes + cost-per-view; monetization progress; LLM strategy review |
| **Scheduler** | Per-task cron with enable/disable; OFF by default for safety |

### Dashboard tabs (http://localhost:3456)
🎬 Long Videos · 📱 Shorts · ⚙️ Schedule · 📊 Analytics · 💬 Engagement · 💰 Costs

---

## Configuration (`.env`)

```env
OPENAI_API_KEY=sk-...                 # required (text, gpt-image-1, TTS)
CHANNEL_NICHE=football                # niche lock
DEFAULT_PRIVACY_STATUS=public         # privacy for uploads
FOOTBALL_DATA_API_KEY=...             # enables real World Cup match videos
OUTPUT_DIR=/path/outside/repo         # where generated media lives (longs/ + shorts/)
# SHORTS_* tune Shorts (resolution, image count/quality, max duration)
```

YouTube OAuth (for uploads) lives in `config/credentials.json` + `config/tokens.json`.
Re-auth: `rm config/tokens.json && node oauth-server.js` → open the consent URL.

**Generated media is stored outside the repo** under `OUTPUT_DIR` (`<OUTPUT_DIR>/longs/`
and `<OUTPUT_DIR>/shorts/`). Defaults to `<repo>/output` if `OUTPUT_DIR` is unset.

---

## Key API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Dashboard |
| GET | `/health` | Status |
| POST | `/generate` | Generate a long video |
| POST | `/generate-short` | Generate a Short |
| POST | `/generate-match` | Generate match recap + Short (World Cup) |
| GET | `/outputs`, `/shorts` | List generated content |
| GET | `/analytics/videos`, `/analytics/monetization` | Performance + monetization |
| GET | `/costs/daily` | Daily spend by category |
| GET | `/comments`, POST `/comments/ingest` | Comment review queue |
| GET/POST | `/automation`, `/automation/toggle` | Scheduler control |

---

## Architecture

- `index.js` — Express server + endpoints + orchestration
- `agents/` — strategy, script, thumbnail, SEO, production, publishing, analytics
- `utils/` — `ai-video-generator`, `shorts-producer`, `worldcup-provider`, `comment-engine`,
  `cost-meter`, `paths`, `credential-manager`
- `database/db.js` — SQLite (cost ledger, content index, comment queue, settings, …)
- `schedules/daily-automation.js` — cron tasks (content, shorts, WC matches, engagement, analytics)
- `public/index.html` — dashboard UI (self-contained, no CDN)

### Pipeline
`ContentStrategy → ScriptWriter → ThumbnailDesigner → SEOOptimizer → ProductionManagement
(images + TTS + ffmpeg assembly) → PublishingScheduling → AnalyticsOptimization`

---

## Notes

- **ffmpeg `drawtext` is unavailable** in the local build — text is rendered via `sharp` SVG overlays.
- **Automation is OFF by default**; enable per-task from the Schedule tab. Uploads can go
  **public** — review before enabling unattended runs.
- Cost is metered per run (~$0.05/Short, ~$0.6–0.7/long video at real gpt-image-1 rates).

## License

MIT — see [LICENSE](LICENSE).
