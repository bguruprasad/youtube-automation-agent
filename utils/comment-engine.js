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
    const { outputRoot, shortsRoot } = require('./paths');
    const root = outputRoot();
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
    scan(shortsRoot(), 'short');
    return out;
  }

  // Does an author display name look like our own channel? (Replies we posted.)
  _isOwnAuthor(name) {
    const ours = (process.env.CHANNEL_NAME || 'HalftimeReplay').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const a = String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    return !!a && (a === ours || a.includes(ours));
  }

  // Fetch comments for one video — top-level comments AND their replies (so
  // replies to OUR replies are visible, not just the thread roots). Returns a
  // flat normalized list. Replies carry isReply + parentId, and
  // replyToOwn=true when the reply is in a thread we participated in (i.e. a
  // direct response to the channel) — those are the conversations worth
  // engaging. Our OWN comments are excluded (we don't reply to ourselves).
  async _fetchVideoComments(videoId, { max = 50 } = {}) {
    const out = [];
    try {
      const resp = await this.youtube.commentThreads.list({
        part: 'snippet,replies', videoId, maxResults: Math.min(max, 100), order: 'time',
      });
      for (const item of (resp.data.items || [])) {
        const top = item.snippet?.topLevelComment;
        const s = top?.snippet;
        if (!s) continue;
        const totalReplies = item.snippet?.totalReplyCount || 0;
        if (!this._isOwnAuthor(s.authorDisplayName)) {
          out.push({
            commentId: top.id, videoId, author: s.authorDisplayName,
            text: s.textOriginal || s.textDisplay || '',
            likeCount: s.likeCount || 0, publishedAt: s.publishedAt,
            totalReplies, isReply: false, parentId: null, replyToOwn: false,
          });
        }

        if (!totalReplies) continue;
        // The commentThreads response inlines up to ~5 recent replies; fetch the
        // full set only when there are more, to keep quota low.
        let replies = item.replies?.comments || [];
        if (totalReplies > replies.length) {
          try {
            const rr = await this.youtube.comments.list({ part: 'snippet', parentId: top.id, maxResults: 100 });
            replies = rr.data.items || replies;
          } catch (e) { this.logger.warn(`Replies fetch failed for ${top.id}: ${e.message}`); }
        }
        // Did WE participate in this thread? (root by us, or any reply by us)
        const weAreInThread = this._isOwnAuthor(s.authorDisplayName) ||
          replies.some(r => this._isOwnAuthor(r.snippet?.authorDisplayName));
        for (const r of replies) {
          const rs = r.snippet; if (!rs) continue;
          if (this._isOwnAuthor(rs.authorDisplayName)) continue; // skip our own replies
          out.push({
            commentId: r.id, videoId, author: rs.authorDisplayName,
            text: rs.textOriginal || rs.textDisplay || '',
            likeCount: rs.likeCount || 0, publishedAt: rs.publishedAt,
            totalReplies: 0, isReply: true, parentId: top.id, replyToOwn: weAreInThread,
          });
        }
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
      // Reply-thread context: a reply in a thread we participated in is usually
      // a follow-up to OUR reply (often a correction or pushback). Tell the LLM
      // so it responds gracefully instead of treating it as a fresh comment.
      const replyCtx = comment.isReply
        ? (comment.replyToOwn
            ? '\nNOTE: This is a REPLY in a thread where our channel already replied — likely a follow-up or pushback to us. Respond gracefully: if a viewer says an AI-generated image doesn\'t look like the real player, acknowledge it honestly and good-naturedly (our recaps use AI-generated visuals, not real match footage); do NOT insist the image is the real person.'
            : '\nNOTE: This is a reply within another viewer\'s thread (not directed at us).')
        : '';
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
              'Our recap visuals are AI-GENERATED (not real footage), so never claim an image IS a real, specific person. ' +
              'If a question asks something you cannot answer from the comment or the video title, reply warmly but generally; never make up facts. ' +
              'Stay neutral on club/national rivalries; never argue or take sides; no politics.',
          },
          {
            role: 'user',
            content: `Video: "${videoTitle}"\nComment by ${comment.author}: "${comment.text}"${replyCtx}`,
          },
        ],
        temperature: 0.7, max_tokens: 200,
      });
      // Track LLM token cost (gpt-4o-mini rates) so engagement spend is ledgered.
      const u = resp.usage || {};
      const inRate = 0.15 / 1e6, outRate = 0.60 / 1e6; // gpt-4o-mini USD/token
      this._llmCost = (this._llmCost || 0) + (u.prompt_tokens || 0) * inRate + (u.completion_tokens || 0) * outRate;

      const txt = resp.choices[0].message.content.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
      const parsed = JSON.parse(txt);
      const cls = ['positive', 'question', 'spam', 'toxic', 'neutral'].includes(parsed.classification)
        ? parsed.classification : 'neutral';
      let reply = (cls === 'positive' || cls === 'question') ? String(parsed.reply || '').trim() : '';
      // Replies in a thread WE'RE in (banter, pushback, follow-ups) are worth
      // engaging even if classified neutral — a viewer talking back to us
      // shouldn't be silently skipped. Draft a reply unless it's spam/toxic.
      // The system prompt already asks for the right tone (esp. AI-image
      // pushback). Use the LLM's reply if present, else a warm generic.
      if (comment.replyToOwn && cls !== 'spam' && cls !== 'toxic' && !reply) {
        reply = String(parsed.reply || '').trim() ||
          'Appreciate you watching and chiming in! 🙌⚽';
      }
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
    this._llmCost = 0; // accumulated by _analyze during this run

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
             (comment_id, video_id, video_title, author, text, classification, draft_reply, status, is_reply, parent_id)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [c.commentId, v.videoId, v.title, c.author, c.text, classification, draftReply, status,
             c.isReply ? 1 : 0, c.parentId || null]
          );
        }
        results.items.push({ ...c, videoTitle: v.title, classification, draftReply, status });
      }
    }
    // Ledger the engagement LLM cost for this run (one row/day, ref by date).
    results.cost = Number((this._llmCost || 0).toFixed(5));
    if (!dryRun && results.cost > 0 && this.db.recordCost) {
      const today = new Date(); const p = n => String(n).padStart(2, '0');
      const dateStr = `${today.getFullYear()}-${p(today.getMonth()+1)}-${p(today.getDate())}`;
      // ref = engagement:<date>:<epoch-min> keeps runs distinct but groups daily.
      await this.db.recordCost({
        category: 'engagement', amount: results.cost,
        detail: `${results.newComments} comments analyzed`,
        ref: `engagement:${dateStr}:${Math.floor(Date.now()/60000)}`,
      });
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
    // YouTube comment threads are flat: a reply must attach to the TOP-LEVEL
    // comment. If this queued item is itself a reply, post into its thread root.
    const targetParent = (row.is_reply && row.parent_id) ? row.parent_id : commentId;
    const replyId = await this.postReply(targetParent, text);
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
