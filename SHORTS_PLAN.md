# YouTube Shorts Feature — Task Plan

**Goal:** Generate vertical 9:16 (1080×1920) YouTube Shorts for the football niche
(Reels/TikTok-style, NOT just short landscape videos). Two modes: fresh single-moment
Shorts, and Shorts repurposed from existing long videos. Output → `output/shorts/`.

**Status legend:** [ ] todo · [~] in progress · [x] done

## Build tasks (ordered for efficiency: foundation → cheapest-to-test → richest)

- [x] 1. **Resolution-aware video engine.** Thread a `dimensions {w,h}` param through
      `generateVideo` → `generateSlideshowVideo` → `_buildClipFilter`. Default stays
      1920×1080 (long video untouched). 16 hardcoded `1920x1080` spots in
      ai-video-generator.js become dimension-driven.
- [x] 2. **Portrait-aware text overlay.** `_makeTextOverlay` takes dimensions; reposition
      the lower-third band + larger mobile font for 9:16.
- [x] 3. **Shorts config.** Env: SHORTS_IMAGE_QUALITY=low, SHORTS_IMAGE_SIZE=1024x1536,
      SHORTS_RESOLUTION=1080x1920, SHORTS_MAX_DURATION=60. Portrait + quality params
      passed to gpt-image-1 (already supports `quality`).
- [x] 4. **Moments provider.** Curated evergreen football-moment pool (always on).
      Recent-moments source via football-data.org is OPTIONAL and gated on
      FOOTBALL_DATA_API_KEY — graceful curated-only fallback when unset.
      (Actual football-data.org signup = user's separate todo, see below.)
- [x] 5. **Short script prompt.** New template: 1 section, ≤150 words (~50-55s),
      hook-heavy. Reuse listicle-title reconciliation where relevant.
- [x] 6. **Mode B — Make Short from existing** (`POST /short-from/:folder`). Reuse a long
      video's images/narration/SEO, fit to vertical, ≤60s. Cheapest to iterate first.
- [x] 7. **Mode A — Fresh Short** (`POST /generate-short`). Moments provider → short
      script → 1-2 portrait low-q images → TTS → vertical assembly → SEO + #Shorts.
- [x] 8. **Dashboard.** "Generate Short" control + "✂️ Make Short" button per existing
      output. Shorts listed from output/shorts/ with their own youtube_upload.json so
      the duplicate-guard + privacy dropdown work.
- [x] 9. **Upload integration.** Reuse uploadOutputFolder (vertical ≤60s + #Shorts =
      auto-classified by YouTube). Sports category. Verified-channel thumbnails work.
- [x] 9b. **Inline "⬆ Upload" button next to each generated short's video link**
      for quick one-click upload (alongside the actions-row Upload Short button).
- [x] 10. **End-to-end test.** One Short each mode → upload unlisted to Halftime Replay
      → verify vertical, in-frame text, audio sync, SEO. Then report for review.
- [x] 11. **Short Ideas suggestions (parity with long-video topic suggestions).**
      `GET /suggest-shorts?count=3` → `momentsProvider.suggestMoments()` (OpenAI when
      available, curated fallback) returns {title, hint, angle, hook}. Shorts tab shows
      selectable idea cards (checkboxes, all checked by default) + "Create Selected
      Shorts" which generates each via /generate-short sequentially. Lets the user see
      what the AI intends to make before committing.
- [x] 11b. **Optional auto-upload after creating.** "Upload to YouTube after creating"
      checkbox + privacy dropdown (defaults to Unlisted) in the Short Ideas actions row.
      When checked, each Short is uploaded via /upload-short/<folder> right after it's
      built (serial: build → upload → next). Public selection triggers a confirm().
      Status line reports both Created N/total and Uploaded N/done.

## Deferred (noted, NOT building now)
- Configurable output path (future `OUTPUT_DIR` env). Structure code so it's easy to add.

## User's separate todo (not mine)
- Sign up for football-data.org free API key, set FOOTBALL_DATA_API_KEY in .env, to
  enable RECENT real-match moments. Curated moments work without it.

## Cost expectation
Fresh single-moment Short ~$0.03-0.04 · Repurposed ~$0-0.02 · vs long video ~$0.26.
Savings come from fewer/cheaper images + shorter TTS — NOT the smaller frame
(image price is resolution-independent).
