// Audience Interaction Engine.
// Reads comments on the channel's OWN uploaded videos, classifies them, drafts
// replies (friendly football-fan voice, concise & FACTUAL — never invents),
// and can heart/reply/pin. Drafts land in the comment_queue table for review;
// posting is a separate, explicit step (review-queue-first model).
//
// Safety: only operates on our own uploaded videos; seen-guard via the
// comment_queue PRIMARY KEY so a comment is never processed twice; rate caps so
// YouTube doesn't treat it as spam; toxic/spam are skipped, never engaged.

const fs = require('fs');
const path = require('path');

class CommentEngine {
  constructor({ youtube, openai, db, logger }) {
    this.youtube = youtube;   // googleapis youtube v3 client (force-ssl scope)
    this.openai = openai;     // OpenAI client (optional; falls back to no-draft)
    this.db = db;
    this.logger = logger || console;
  }

  // Video IDs we've uploaded, from the youtube_upload.json markers (same source
  // the analytics report uses). Returns [{ videoId, title }].
  _ownVideos() {
    const root = path.join(__dirname, '..', 'output');
    const out = [];
    const scan = (dir, kind) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === 'shorts') continue;
        const folder = path.join(dir, e.name);
        try {
          const marker = JSON.parse(fs.readFileSync(path.join(folder, 'youtube_upload.json'), 'utf8'));
          if (!marker.videoId) continue;
          let title = e.name;
          try { title = JSON.parse(fs.readFileSync(path.join(folder, 'script.json'), 'utf8')).title || title; } catch {}
          out.push({ videoId: marker.videoId, title, kind });
        } catch { /* not uploaded */ }
      }
    };
    scan(root, 'long');
    scan(path.join(root, 'shorts'), 'short');
    return out;
  }

  // Fetch top-level comments for one video. Returns normalized comments.
  async _fetchVideoComments(videoId, { max = 50 } = {}) {
    const out = [];
    try {
      const resp = await this.youtube.commentThreads.list({
        part: 'snippet', videoId, maxResults: Math.min(max, 100), order: 'time',
      });
      for (const item of (resp.data.items || [])) {
        const top = item.snippet?.topLevelComment;
        const s = top?.snippet;
        if (!s) continue;
        out.push({
          commentId: top.id,
          videoId,
          author: s.authorDisplayName,
          text: s.textOriginal || s.textDisplay || '',
          likeCount: s.likeCount || 0,
          publishedAt: s.publishedAt,
          totalReplies: item.snippet?.totalReplyCount || 0,
        });
      }
    } catch (e) {
      // commentsDisabled / not found / quota — skip this video gracefully.
      this.logger.warn(`Comment fetch failed for ${videoId}: ${e.message}`);
    }
    return out;
  }

  // Which comment_ids are already in the queue (seen-guard).
  async _seenIds(ids) {
    if (!ids.length) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const rows = await this.db.getAllRows(
      `SELECT comment_id FROM comment_queue WHERE comment_id IN (${placeholders})`, ids);
    return new Set(rows.map(r => r.comment_id));
  }

  // Classify + draft a reply for one comment via the LLM. Returns
  // { classification, draftReply }. classification: positive|question|spam|toxic|neutral.
  // draftReply is '' for spam/toxic/neutral (we only reply to positive/question).
  async _analyze(comment, videoTitle) {
    if (!this.openai) return { classification: 'neutral', draftReply: '' };
    try {
      const resp = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You moderate and reply to comments on a football (soccer) YouTube channel ("Halftime Replay"). ' +
              'Return ONLY JSON: {"classification":"positive|question|spam|toxic|neutral","reply":"..."}. ' +
              'Classify the comment. Write a reply ONLY for positive or question comments; for spam/toxic/neutral set reply to "". ' +
              'Reply voice: friendly football fan, CONCISE (<=200 chars), warm. ' +
              'CRITICAL: be factual — do NOT invent stats, scores, player names, or events. ' +
              'If a question asks something you cannot answer from the comment or the video title, reply warmly but generally; never make up facts. ' +
              'Stay neutral on club/national rivalries; never argue or take sides; no politics.',
          },
          {
            role: 'user',
            content: `Video: "${videoTitle}"\nComment by ${comment.author}: "${comment.text}"`,
          },
        ],
        temperature: 0.7, max_tokens: 200,
      });
      const txt = resp.choices[0].message.content.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
      const parsed = JSON.parse(txt);
      const cls = ['positive', 'question', 'spam', 'toxic', 'neutral'].includes(parsed.classification)
        ? parsed.classification : 'neutral';
      let reply = (cls === 'positive' || cls === 'question') ? String(parsed.reply || '').trim() : '';
      if (reply.length > 280) reply = reply.slice(0, 277) + '…';
      return { classification: cls, draftReply: reply };
    } catch (e) {
      this.logger.warn(`Comment analyze failed: ${e.message}`);
      return { classification: 'neutral', draftReply: '' };
    }
  }

  // Main ingest pass: fetch new comments across own videos, classify+draft, and
  // store in the queue. Optionally auto-heart positives. Caps per run.
  //   opts.maxVideos   - how many recent videos to scan (default 15)
  //   opts.maxPerRun   - cap new comments processed per run (default 40)
  //   opts.dryRun      - don't write to DB; just return findings (read-only)
  async ingest({ maxVideos = 15, maxPerRun = 40, dryRun = false } = {}) {
    const videos = this._ownVideos().slice(0, maxVideos);
    const results = { scannedVideos: videos.length, newComments: 0, byClass: {}, items: [] };

    for (const v of videos) {
      if (results.newComments >= maxPerRun) break;
      const comments = await this._fetchVideoComments(v.videoId);
      if (!comments.length) continue;
      const seen = await this._seenIds(comments.map(c => c.commentId));

      for (const c of comments) {
        if (results.newComments >= maxPerRun) break;
        if (seen.has(c.commentId)) continue;

        const { classification, draftReply } = await this._analyze(c, v.title);
        results.byClass[classification] = (results.byClass[classification] || 0) + 1;
        results.newComments++;

        const status = (classification === 'spam' || classification === 'toxic') ? 'skipped'
          : (draftReply ? 'pending' : 'skipped');

        if (!dryRun) {
          await this.db.executeQuery(
            `INSERT OR IGNORE INTO comment_queue
             (comment_id, video_id, video_title, author, text, classification, draft_reply, status)
             VALUES (?,?,?,?,?,?,?,?)`,
            [c.commentId, v.videoId, v.title, c.author, c.text, classification, draftReply, status]
          );
        }
        results.items.push({ ...c, videoTitle: v.title, classification, draftReply, status });
      }
    }
    return results;
  }

  // --- Actions (force-ssl scope) ---
  // NOTE on API limits (YouTube Data API v3):
  //  - Replying:  supported (comments.insert).            ✅
  //  - Heart:     NO public endpoint to set the creator heart. ❌ (web/app only)
  //  - Pin:       NO public endpoint to pin a comment.        ❌ (web/app only)
  //  - Moderation: comments.setModerationStatus can mark spam as 'rejected'.
  // So this engine focuses on REPLIES + spam moderation. Heart/pin are tracked
  // in classification (so you can do them manually) but cannot be automated.

  // Optionally mark a comment as spam (moderation). Best-effort.
  async rejectAsSpam(commentId) {
    try {
      await this.youtube.comments.setModerationStatus({ id: commentId, moderationStatus: 'rejected' });
      return true;
    } catch (e) { this.logger.warn(`Spam reject failed for ${commentId}: ${e.message}`); return false; }
  }

  // Post a reply to a comment thread. Returns the new reply id or null.
  async postReply(parentCommentId, text) {
    const resp = await this.youtube.comments.insert({
      part: 'snippet',
      requestBody: { snippet: { parentId: parentCommentId, textOriginal: text } },
    });
    return resp.data.id || null;
  }

  // Approve + post a queued reply by comment_id. Optionally override the text.
  async postQueued(commentId, overrideText = null) {
    const row = await this.db.getRow('SELECT * FROM comment_queue WHERE comment_id = ?', [commentId]);
    if (!row) throw new Error('Comment not in queue');
    const text = (overrideText != null ? overrideText : row.draft_reply || '').trim();
    if (!text) throw new Error('No reply text to post');
    const replyId = await this.postReply(commentId, text);
    await this.db.executeQuery(
      `UPDATE comment_queue SET status='posted', draft_reply=?, reply_id=?, published_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE comment_id=?`,
      [text, replyId, commentId]
    );
    return { commentId, replyId };
  }

  async skipQueued(commentId) {
    await this.db.executeQuery(
      `UPDATE comment_queue SET status='skipped', updated_at=CURRENT_TIMESTAMP WHERE comment_id=?`, [commentId]);
    return { commentId, status: 'skipped' };
  }
}

module.exports = { CommentEngine };
