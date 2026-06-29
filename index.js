require('dotenv').config(); // load .env (FOOTBALL_DATA_API_KEY, CHANNEL_*, SHORTS_*, etc.)
const express = require('express');
const path = require('path');
const { outputRoot, shortsRoot } = require('./utils/paths'); // OUTPUT_DIR-aware paths
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold('\n🎬 YouTube Automation Agent v1.0'));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        return false;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      
      // Setup API endpoints
      this.setupAPI();
      
      // Generation queue: serialize heavy generation so concurrent ffmpeg/Flux
      // runs don't thrash the machine (which caused render timeouts). DB-persisted
      // and FIFO; runners are registered below.
      const { GenerationQueue } = require('./utils/generation-queue');
      this.genQueue = new GenerationQueue(this.db, this.logger);
      this._registerQueueRunners();
      await this.genQueue.start();

      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, this);
      await this.scheduler.initialize();

      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }

    // Shorts producer (reuses the production agent's AIVideoGenerator).
    const { ShortsProducer } = require('./utils/shorts-producer');
    this.shortsProducer = new ShortsProducer(this.agents.production.aiVideoGenerator, this.logger);

    // Audience interaction engine (comment replies). Uses the YouTube client +
    // OpenAI. Tolerates missing YouTube creds (endpoints will report it).
    try {
      const { CommentEngine } = require('./utils/comment-engine');
      const yt = (() => { try { return this.credentials.getYouTubeClient(); } catch { return null; } })();
      this.commentEngine = new CommentEngine({
        youtube: yt,
        openai: this.agents.strategy.openai || null,
        db: this.db,
        logger: this.logger,
      });
    } catch (e) {
      this.logger.warn(`Comment engine not initialized: ${e.message}`);
      this.commentEngine = null;
    }
  }

  setupAPI() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // Serve output files (thumbnails, videos, etc.)
    this.app.get('/output/:folder/:file', (req, res) => {
      const { folder, file } = req.params;
      const filePath = path.join(outputRoot(), folder, file);
      res.sendFile(filePath, (err) => {
        // sendFile's callback fires for any error, including a client abort
        // mid-stream — by which point headers are already sent. Responding
        // again throws ERR_HTTP_HEADERS_SENT and (unhandled) crashes the
        // process, so only reply when nothing has been sent yet.
        if (err && !res.headersSent) {
          res.status(404).json({ error: 'File not found' });
        }
      });
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        initialized: this.isInitialized,
        agents: Object.keys(this.agents),
        timestamp: new Date().toISOString()
      });
    });

    // Manual content generation
    this.app.post('/generate', async (req, res) => {
      try {
        const { topic, style, length } = req.body;
        const result = await this.generateContent(topic, style, length);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Suggest trending topics before committing to generation
    this.app.get('/suggest', async (req, res) => {
      try {
        const { niche, count } = req.query;
        const suggestions = await this.agents.strategy.suggestTopics(niche || null, parseInt(count) || 5);
        res.json({ success: true, suggestions });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // List previous long-video generations. List comes from the generated_content
    // index (DB = source of truth for what exists); each row is enriched from its
    // folder (cost/meta/files/upload status). Long videos + match recaps live in
    // longs/. Rows whose folder is gone on disk are skipped.
    this.app.get('/outputs', async (req, res) => {
      try {
        const baseDir = outputRoot();
        const rows = await this.db.getContent({});
        const longRows = rows.filter(r => r.type === 'long' || r.type === 'match_recap');
        const outputs = [];
        for (const r of longRows) {
          const item = await this._enrichFolder(r.folder, baseDir);
          if (item) outputs.push(item);
        }
        outputs.sort((a, b) => b.modifiedAt - a.modifiedAt);
        res.json({ success: true, outputs });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        const analytics = await this.agents.analytics.getRecentAnalytics();
        res.json(analytics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Per-video analytics for everything uploaded via the dashboard (reads
    // youtube_upload.json markers + live YouTube stats). Powers the Analytics tab.
    this.app.get('/analytics/videos', async (req, res) => {
      try {
        const report = await this.agents.analytics.getUploadedVideosReport();
        res.json({ success: true, ...report });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Monetization progress vs YouTube Partner Program thresholds.
    this.app.get('/analytics/monetization', async (req, res) => {
      try {
        const status = await this.agents.analytics.getMonetizationStatus();
        res.json({ success: true, status });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Daily spend by category (for admin cost analytics / future graphs).
    // ?days=30. Returns raw rows + a pivoted series ready for charting.
    this.app.get('/costs/daily', async (req, res) => {
      try {
        const days = parseInt(req.query.days) || 30;
        const rows = await this.db.getDailyCosts(days);
        // Pivot: { dates:[...], categories:[...], series:{cat:[amts aligned to dates]}, totalsByCategory, grandTotal }
        const dates = [...new Set(rows.map(r => r.date))].sort();
        const categories = [...new Set(rows.map(r => r.category))].sort();
        const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
        const series = {}; const totalsByCategory = {};
        for (const cat of categories) { series[cat] = dates.map(() => 0); totalsByCategory[cat] = 0; }
        let grandTotal = 0;
        for (const r of rows) { series[r.category][idx[r.date]] = r.amount; totalsByCategory[r.category] += r.amount; grandTotal += r.amount; }
        for (const c of categories) totalsByCategory[c] = Number(totalsByCategory[c].toFixed(4));

        // Provider split (OpenAI vs Replicate vs ElevenLabs): per-day series +
        // totals, aligned to the same `dates` axis.
        const provRows = await this.db.getDailyCostsByProvider(days);
        const providers = [...new Set(provRows.map(r => r.provider))].sort();
        const providerSeries = {}; const totalsByProvider = {};
        for (const pr of providers) { providerSeries[pr] = dates.map(() => 0); totalsByProvider[pr] = 0; }
        for (const r of provRows) {
          if (idx[r.date] == null) continue;
          providerSeries[r.provider][idx[r.date]] = r.amount;
          totalsByProvider[r.provider] += r.amount;
        }
        for (const pr of providers) totalsByProvider[pr] = Number(totalsByProvider[pr].toFixed(4));

        res.json({ success: true, days, dates, categories, series, totalsByCategory,
          providers, providerSeries, totalsByProvider,
          grandTotal: Number(grandTotal.toFixed(4)) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // --- Notifications (dashboard alert list) ---
    this.app.get('/notifications', async (req, res) => {
      try {
        const unreadOnly = req.query.unread === '1';
        const items = await this.db.getNotifications({ unreadOnly });
        const unread = items.filter(n => !n.read).length;
        res.json({ success: true, items, unread });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/notifications/:id/read', async (req, res) => {
      try { await this.db.markNotificationRead(parseInt(req.params.id)); res.json({ success: true }); }
      catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    // Clear one (?id=N via param) or all notifications.
    this.app.post('/notifications/clear', async (req, res) => {
      try { await this.db.clearNotifications(req.query.id ? parseInt(req.query.id) : null); res.json({ success: true }); }
      catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    // --- Audience interaction (comments) ---
    // List the comment queue (default: pending review). ?status=all|pending|posted|skipped
    this.app.get('/comments', async (req, res) => {
      try {
        const status = req.query.status || 'pending';
        const where = status === 'all' ? '' : 'WHERE status = ?';
        const params = status === 'all' ? [] : [status];
        const rows = await this.db.getAllRows(
          `SELECT * FROM comment_queue ${where} ORDER BY created_at DESC LIMIT 200`, params);
        const counts = await this.db.getAllRows('SELECT status, COUNT(*) n FROM comment_queue GROUP BY status');
        res.json({ success: true, comments: rows, counts });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Scan own videos for new comments, classify + draft into the queue.
    this.app.post('/comments/ingest', async (req, res) => {
      try {
        if (!this.commentEngine || !this.commentEngine.youtube) throw new Error('Comment engine/YouTube not configured');
        const result = await this.commentEngine.ingest({
          maxVideos: parseInt(req.body?.maxVideos) || 40,
          maxPerRun: parseInt(req.body?.maxPerRun) || 40,
        });
        res.json({ success: true, result });
      } catch (error) {
        this.logger.error('Comment ingest failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Approve + post a queued reply (optional edited text in body.text).
    this.app.post('/comments/:id/post', async (req, res) => {
      try {
        if (!this.commentEngine || !this.commentEngine.youtube) throw new Error('Comment engine/YouTube not configured');
        const result = await this.commentEngine.postQueued(req.params.id, req.body?.text ?? null);
        res.json({ success: true, ...result });
      } catch (error) {
        this.logger.error('Comment reply failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Skip a queued comment (won't reply).
    this.app.post('/comments/:id/skip', async (req, res) => {
      try {
        const result = await this.commentEngine.skipQueued(req.params.id);
        res.json({ success: true, ...result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Strategy review: last persisted report (fast) or generate a fresh one.
    this.app.get('/strategy-review', async (req, res) => {
      try {
        const review = this.agents.analytics.getLastStrategyReview();
        res.json({ success: true, review });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    this.app.post('/strategy-review/generate', async (req, res) => {
      try {
        const review = await this.agents.analytics.generateStrategyReview();
        res.json({ success: true, review });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Automation scheduler: status, master toggle, and run-a-task-now.
    this.app.get('/automation', async (req, res) => {
      try {
        if (!this.scheduler) return res.json({ success: false, error: 'Scheduler not initialized' });
        res.json({ success: true, status: await this.scheduler.getAutomationStatus() });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Generation queue status: what's running now, what's waiting, recent results.
    this.app.get('/queue', async (req, res) => {
      try {
        if (!this.genQueue) return res.json({ success: false, error: 'Queue not initialized' });
        res.json({ success: true, queue: await this.genQueue.status() });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Body: { enabled: true|false }. Persists the master switch.
    this.app.post('/automation/toggle', async (req, res) => {
      try {
        if (!this.scheduler) throw new Error('Scheduler not initialized');
        const enabled = !!(req.body && req.body.enabled);
        if (enabled) await this.scheduler.resumeAutomation();
        else await this.scheduler.pauseAutomation();
        res.json({ success: true, enabled, status: await this.scheduler.getAutomationStatus() });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get/set the number of Shorts the daily Shorts task generates.
    this.app.get('/automation/shorts-count', async (req, res) => {
      try {
        const count = parseInt(await this.db.getSetting('daily_shorts_count')) || 1;
        res.json({ success: true, count });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    this.app.post('/automation/shorts-count', async (req, res) => {
      try {
        let count = parseInt(req.body && req.body.count);
        if (!Number.isFinite(count) || count < 0) throw new Error('count must be a non-negative integer');
        count = Math.min(count, 10); // sane upper bound (cost guard)
        await this.db.setSetting('daily_shorts_count', String(count), 'How many Shorts the daily Shorts task generates');
        res.json({ success: true, count });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stock-clips (Pexels B-roll in Shorts) GLOBAL default toggle. This sets the
    // default for all Shorts incl. automation; the manual /generate-short can
    // still override per-run via { useClips }. Mode is mix|background.
    this.app.get('/automation/stock-clips', async (req, res) => {
      try {
        const shortsConfig = require('./utils/shorts-config');
        const setting = await this.db.getSetting('stock_clips_enabled');
        const enabled = setting == null
          ? shortsConfig.stockClips.enabledDefault   // fall back to env default
          : setting === 'true';
        const mode = (await this.db.getSetting('stock_clips_mode')) || shortsConfig.stockClips.mode;
        res.json({ success: true, enabled, mode, hasKey: !!shortsConfig.stockClips.apiKey });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    this.app.post('/automation/stock-clips', async (req, res) => {
      try {
        if (req.body && req.body.enabled != null) {
          await this.db.setSetting('stock_clips_enabled', String(!!req.body.enabled),
            'Use Pexels stock B-roll clips in Shorts (global default)');
        }
        if (req.body && req.body.mode) {
          const mode = String(req.body.mode).toLowerCase();
          if (!['mix', 'background'].includes(mode)) throw new Error("mode must be 'mix' or 'background'");
          await this.db.setSetting('stock_clips_mode', mode, 'Stock-clip layout mode');
        }
        const enabled = (await this.db.getSetting('stock_clips_enabled')) === 'true';
        const mode = (await this.db.getSetting('stock_clips_mode')) || require('./utils/shorts-config').stockClips.mode;
        res.json({ success: true, enabled, mode });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Enable/disable a single task. Body: { enabled: true|false }.
    this.app.post('/automation/task/:task/toggle', async (req, res) => {
      try {
        if (!this.scheduler) throw new Error('Scheduler not initialized');
        const enabled = !!(req.body && req.body.enabled);
        const result = await this.scheduler.setTaskEnabled(req.params.task, enabled);
        res.json({ success: true, ...result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Run one scheduled task immediately (manual trigger). Long tasks (content
    // generation) can take minutes; the request waits for completion.
    this.app.post('/automation/run/:task', async (req, res) => {
      try {
        if (!this.scheduler) throw new Error('Scheduler not initialized');
        const result = await this.scheduler.runTaskNow(req.params.task);
        res.json({ success: true, result });
      } catch (error) {
        this.logger.error(`Manual task run failed (${req.params.task}):`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', async (req, res) => {
      try {
        const { contentId } = req.params;
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Upload a specific generated output folder straight to YouTube (used by
    // the dashboard "Upload" button). Optional body: { privacy: 'unlisted' }.
    this.app.post('/upload/:folder', async (req, res) => {
      try {
        const folder = path.basename(req.params.folder); // prevent path traversal
        const folderPath = path.join(outputRoot(), folder);
        const privacy = (req.body && req.body.privacy) || undefined;
        const force = !!(req.body && req.body.force);

        // Duplicate guard: refuse if already uploaded, unless force=true.
        const markerPath = path.join(folderPath, 'youtube_upload.json');
        const fsp = require('fs').promises;
        let existing = null;
        try { existing = JSON.parse(await fsp.readFile(markerPath, 'utf8')); } catch {}
        if (existing && !force) {
          return res.status(409).json({
            success: false,
            alreadyUploaded: true,
            error: `Already uploaded to YouTube (${existing.url}). Re-upload would create a duplicate.`,
            uploaded: existing,
          });
        }

        const result = await this.agents.publishing.uploadOutputFolder(folderPath, { privacyStatus: privacy, force });
        res.json({ success: true, ...result });
      } catch (error) {
        this.logger.error('Dashboard upload failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Upload a generated Short to YouTube (from output/shorts/<folder>).
    this.app.post('/upload-short/:folder', async (req, res) => {
      try {
        const shortsConfig = require('./utils/shorts-config');
        const folder = path.basename(req.params.folder);
        const folderPath = path.join(shortsConfig.outputDir, folder);
        const privacy = (req.body && req.body.privacy) || undefined;
        const force = !!(req.body && req.body.force);
        const fsp = require('fs').promises;
        const markerPath = path.join(folderPath, 'youtube_upload.json');
        let existing = null;
        try { existing = JSON.parse(await fsp.readFile(markerPath, 'utf8')); } catch {}
        if (existing && !force) {
          return res.status(409).json({ success: false, alreadyUploaded: true,
            error: `Already uploaded (${existing.url}).`, uploaded: existing });
        }
        const result = await this.agents.publishing.uploadOutputFolder(folderPath, { privacyStatus: privacy, force });
        res.json({ success: true, ...result });
      } catch (error) {
        this.logger.error('Short upload failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Serve files from a Short folder.
    this.app.get('/short-file/:folder/:file', (req, res) => {
      const shortsConfig = require('./utils/shorts-config');
      const folder = path.basename(req.params.folder);
      const file = path.basename(req.params.file);
      res.sendFile(path.join(shortsConfig.outputDir, folder, file), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
      });
    });

    // List generated Shorts. List from the generated_content index (type short
    // or match_recap shorts live in shorts/); each enriched from its folder.
    this.app.get('/shorts', async (req, res) => {
      try {
        const shortsConfig = require('./utils/shorts-config');
        const baseDir = shortsConfig.outputDir;
        // Match recaps produce BOTH a long and a short; the short folder lives in
        // shorts/. We can't tell from type alone which match_recap rows are the
        // short side, so enrich every short-type row, and for match_recap rows
        // try the shorts dir (enrich returns null if not present there).
        const rows = await this.db.getContent({});
        const candidates = rows.filter(r => r.type === 'short' || r.type === 'match_recap');
        const shorts = [];
        for (const r of candidates) {
          const item = await this._enrichFolder(r.folder, baseDir);
          if (item) shorts.push(item);
        }
        shorts.sort((a, b) => b.modifiedAt - a.modifiedAt);
        res.json({ success: true, shorts });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Suggest Short ideas before committing to generation. Shows what the AI
    // intends to make (title + angle + hook) so the user can pick which to build.
    this.app.get('/suggest-shorts', async (req, res) => {
      try {
        const momentsProvider = require('./utils/football-moments-provider');
        const count = parseInt(req.query.count) || 3;
        const suggestions = await momentsProvider.suggestMoments({
          count,
          openai: this.agents.strategy.openai || null,
          logger: this.logger,
        });
        res.json({ success: true, suggestions });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Mode A - Fresh single-moment Short. Optional body: { moment } to force a
    // specific subject; otherwise the moments provider picks one (curated, or
    // recent via football-data.org when configured).
    this.app.post('/generate-short', async (req, res) => {
      try {
        const moment = (req.body && req.body.moment) || null;
        const useClips = req.body && req.body.useClips;
        const { id } = await this.genQueue.enqueue({
          kind: 'short',
          label: moment || 'auto moment',
          payload: { moment, useClips },
        });
        res.json({ success: true, queued: true, jobId: id,
          message: 'Short queued for generation; it will render one-at-a-time.' });
      } catch (error) {
        this.logger.error('Short enqueue failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Generate recap videos (long + short) for a World Cup match. Body (optional):
    // { matchId, formats:['long','short'] }. If no matchId, uses the most recent
    // finished WC match. Manual/testing counterpart to the scheduled task.
    this.app.post('/generate-match', async (req, res) => {
      try {
        const matchId = req.body && req.body.matchId;
        const formats = (req.body && req.body.formats) || ['long', 'short'];
        const { id } = await this.genQueue.enqueue({
          kind: 'match_recap',
          label: matchId ? `match ${matchId}` : 'latest match',
          payload: { matchId, formats },
          dedupKey: matchId ? `match_recap:${matchId}` : null,
        });
        res.json({ success: true, queued: true, jobId: id,
          message: 'Match recap queued for generation.' });
      } catch (error) {
        this.logger.error('Match enqueue failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Mode B - Make a Short from an existing long-video output folder.
    this.app.post('/short-from/:folder', async (req, res) => {
      try {
        const folder = path.basename(req.params.folder);
        const srcPath = path.join(outputRoot(), folder);
        const fsp = require('fs').promises;
        const script = JSON.parse(await fsp.readFile(path.join(srcPath, 'script.json'), 'utf8'));

        // Build a short script from the source: prefer its strongest section.
        const sections = (script.mainContent && script.mainContent.sections) || [];
        const chosen = sections[0] || { title: script.title, content: script.hook?.text || script.title };
        const shortScript = await this.agents.scriptWriter.generateShortScript({
          title: chosen.title || script.title,
          hint: (typeof chosen.content === 'string' ? chosen.content : '').slice(0, 300),
          recent: false,
        });

        // Reuse the source folder's images.
        const assetsDir = path.join(srcPath, 'assets');
        let images = [];
        try {
          const files = (await fsp.readdir(assetsDir)).filter(f => f.endsWith('.png')).sort();
          images = files.slice(0, 2).map(f => path.join(assetsDir, f));
        } catch {}
        if (!images.length) throw new Error('No source images found to repurpose.');

        // Meter this run (reuses source images, so only TTS is charged here).
        const { CostMeter } = require('./utils/cost-meter');
        this.agents.production.aiVideoGenerator.costMeter = new CostMeter();

        const srcThumb = path.join(srcPath, 'thumbnail.png');
        const clipOpts = await this._resolveClipOptions(req.body && req.body.useClips);
        const result = await this.shortsProducer.produce(shortScript, images, {
          sourceThumb: require('fs').existsSync(srcThumb) ? srcThumb : null,
          ...clipOpts,
        });
        await this._ledgerFolderCost(result.folder, 'short', require('./utils/shorts-config').outputDir);
        await this.db.upsertContent({ folder: result.folder, type: 'short', title: shortScript.title });
        res.json({ success: true, folder: result.folder, title: shortScript.title, source: folder });
      } catch (error) {
        this.logger.error('Short-from-existing failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Express error handler (must be LAST, 4-arg). Catches errors thrown from
    // routes / streaming so one bad request can't bubble up and crash the
    // automation server. Skips replying if a response is already in flight.
    this.app.use((err, req, res, next) => {
      this.logger.error(`Unhandled request error (${req.method} ${req.path}): ${err.message}`);
      if (res.headersSent) return next(err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    });
  }

  // Register the generation-queue runners. Each runner does the actual heavy work
  // for one job kind; the queue calls them one at a time with a delay between.
  _registerQueueRunners() {
    this.genQueue.register('short', (payload) => this._runShortJob(payload));
    this.genQueue.register('match_recap', (payload) => this._runMatchJob(payload));
    // WC match recap (generate + auto-upload) — the scheduler enqueues these so
    // the hourly batch serializes instead of thrashing the machine.
    this.genQueue.register('wc-match', (payload) => this._runWcMatchJob(payload));
    // Daily long video — the full pipeline (strategy → script → thumbnail → SEO
    // → production → schedule). Enqueued so it serializes with shorts/recaps
    // instead of running inline on the cron callback and thrashing ffmpeg/Flux.
    this.genQueue.register('long', (payload) => this._runLongJob(payload));
  }

  // Queue runner for the daily long video (the core of runDailyContentGeneration).
  // Strategy/topic is chosen here, when the worker starts the job, so it's fresh
  // at run time. Returns a summary. payload: {} (no fields needed today).
  async _runLongJob(payload = {}) {
    const { CostMeter } = require('./utils/cost-meter');
    this.agents.production.aiVideoGenerator.costMeter = new CostMeter();

    const strategy = await this.agents.strategy.generateContentStrategy();
    this.logger.info(`Long job strategy: ${strategy.topic}`);

    const script = await this.agents.scriptWriter.generateScript(strategy);
    this.logger.info(`Long job script: ${script.title}`);

    const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
    const seoData = await this.agents.seoOptimizer.optimize(script, strategy);

    const productionData = await this.agents.production.processContent({
      strategy, script, thumbnail, seo: seoData,
    });
    this.logger.info(`Long job production completed: ${productionData.id}`);

    await this.agents.publishing.scheduleContent(productionData);

    // productionData exposes an absolute outputDir, not a bare folder name; the
    // ledger/content index key on the basename (move-proof) under longs/.
    const folder = productionData.outputDir ? path.basename(productionData.outputDir) : null;
    if (folder) {
      const { outputRoot } = require('./utils/paths');
      await this._ledgerFolderCost(folder, 'video', outputRoot());
      await this.db.upsertContent({ folder, type: 'long', title: script.title });
    }
    return { folder, title: script.title, topic: strategy.topic };
  }

  // Queue runner for a scheduled World Cup match: generate the recap in the
  // requested format(s) and auto-upload at the given privacy. payload:
  // { match, format, privacy }. The cron has already cross-checked the score and
  // marked the seen-guard before enqueuing, so this just produces + uploads.
  async _runWcMatchJob(payload = {}) {
    const { match, format, privacy } = payload;
    const result = await this.generateMatchVideos(match, { formats: [format] });
    const { outputRoot, shortsRoot } = require('./utils/paths');
    const path = require('path');
    try {
      if (format === 'long' && result.long?.folder) {
        await this.agents.publishing.uploadOutputFolder(path.join(outputRoot(), result.long.folder), { privacyStatus: privacy });
      } else if (format === 'short' && result.short?.folder) {
        await this.agents.publishing.uploadOutputFolder(path.join(shortsRoot(), result.short.folder), { privacyStatus: privacy });
      }
    } catch (e) { this.logger.warn(`WC ${format} upload failed: ${e.message}`); }
    return { format, fixture: `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}` };
  }

  // Generate one fresh single-moment Short (the core of POST /generate-short),
  // runnable from the queue. payload: { moment?, useClips? }. Returns a summary.
  async _runShortJob(payload = {}) {
    const shortsConfig = require('./utils/shorts-config');
    const momentsProvider = require('./utils/football-moments-provider');
    const forced = payload.moment;
    const moment = forced
      ? { title: forced, hint: '', recent: false }
      : await momentsProvider.getMoment({ logger: this.logger });

    this.logger.info(`Generating Short for moment: ${moment.title}`);
    const script = await this.agents.scriptWriter.generateShortScript(moment);

    const { CostMeter } = require('./utils/cost-meter');
    this.agents.production.aiVideoGenerator.costMeter = new CostMeter();

    const images = [];
    const sceneDirection = (script.mainContent?.sections || [])
      .map(s => Array.isArray(s.visuals) ? s.visuals.join(', ') : s.visuals).filter(Boolean).join('; ');
    const visualPrompt = this.agents.production.aiVideoGenerator.buildSceneImagePrompt(
      moment.title, { hint: moment.hint, sceneDirection });
    for (let i = 0; i < shortsConfig.imageCount; i++) {
      const assets = await this.agents.production.aiVideoGenerator.generateVisualAssets(
        visualPrompt, 'cinematic', 1,
        { size: shortsConfig.imageSize, quality: shortsConfig.imageQuality, format: 'short' }
      );
      images.push(...assets);
    }

    const clipOpts = await this._resolveClipOptions(payload.useClips);
    const result = await this.shortsProducer.produce(script, images, clipOpts);
    await this._ledgerFolderCost(result.folder, 'short', shortsConfig.outputDir);
    await this.db.upsertContent({ folder: result.folder, type: 'short', title: script.title });

    // Auto-upload when requested (daily-shorts cron sets this). Privacy comes
    // from the payload (resolved by the cron from the daily_shorts_privacy
    // setting). Manual /generate-short jobs don't set autoUpload, so they stay
    // drafts for the operator to publish.
    let uploaded = null;
    if (payload.autoUpload) {
      try {
        const fp = require('path').join(shortsConfig.outputDir, result.folder);
        const up = await this.agents.publishing.uploadOutputFolder(fp, { privacyStatus: payload.privacy || 'public' });
        uploaded = up && up.url ? up.url : true;
        this.logger.info(`Daily Short auto-uploaded (${payload.privacy || 'public'}): ${up && up.url}`);
      } catch (e) { this.logger.warn(`Daily Short auto-upload failed: ${e.message}`); }
    }
    return { folder: result.folder, title: script.title, moment: moment.title, uploaded };
  }

  // Generate recap videos for a match (the core of POST /generate-match), runnable
  // from the queue. payload: { matchId?, formats? }.
  async _runMatchJob(payload = {}) {
    const wc = require('./utils/worldcup-provider');
    const formats = payload.formats || ['long', 'short'];
    const matches = await wc.getFinishedMatches({ logger: this.logger });
    if (!matches.length) throw new Error('No finished WC matches found.');
    const match = payload.matchId ? matches.find(m => m.id === payload.matchId) : matches[matches.length - 1];
    if (!match) throw new Error(`Match ${payload.matchId} not found.`);
    this.logger.info(`Generating match videos: ${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`);
    const result = await this.generateMatchVideos(match, { formats });
    return { match: `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`, result };
  }

  // Resolve whether a Short should use stock clips, and in which mode. Precedence:
  //   per-run override (req.body.useClips) > DB setting > env default.
  // Returns { useClips, clipMode }. A missing PEXELS key forces useClips off
  // (the provider would fail open anyway, but this keeps logs/meta honest).
  async _resolveClipOptions(override) {
    const shortsConfig = require('./utils/shorts-config');
    if (!shortsConfig.stockClips.apiKey) return { useClips: false, clipMode: shortsConfig.stockClips.mode };
    let useClips;
    if (override != null) {
      useClips = !!override;
    } else {
      const setting = await this.db.getSetting('stock_clips_enabled');
      useClips = setting == null ? shortsConfig.stockClips.enabledDefault : setting === 'true';
    }
    const clipMode = (await this.db.getSetting('stock_clips_mode')) || shortsConfig.stockClips.mode;
    return { useClips, clipMode };
  }

  // Record a generated folder's cost into the cost ledger (idempotent by folder
  // ref). category: video|short|match_recap. Reads the cost from script.json.
  // Enrich one content row from its folder on disk (cost/meta/files/upload
  // status). Returns the dashboard item object, or null if the folder is gone
  // (deleted manually) so the caller can skip it. `baseDir` is longs/ or shorts/.
  async _enrichFolder(folder, baseDir) {
    const fsp = require('fs').promises;
    const dirPath = path.join(baseDir, folder);
    try {
      const script = JSON.parse(await fsp.readFile(path.join(dirPath, 'script.json'), 'utf8'));
      const files = await fsp.readdir(dirPath);
      const stat = await fsp.stat(dirPath);
      let uploaded = null;
      if (files.includes('youtube_upload.json')) {
        try { uploaded = JSON.parse(await fsp.readFile(path.join(dirPath, 'youtube_upload.json'), 'utf8')); } catch {}
      }
      return {
        folder,
        title: script.title,
        files: files.filter(f => !f.startsWith('.')),
        hasVideo: files.includes('video.mp4'),
        hasThumbnail: files.includes('thumbnail.png'),
        createdAt: script.createdAt || null,
        modifiedAt: stat.mtimeMs,
        uploaded,
        cost: script.cost || null,
        meta: script.meta || null,
      };
    } catch {
      return null; // folder missing/unreadable — skip
    }
  }

  async _ledgerFolderCost(folder, category, baseDir) {
    try {
      const fsp = require('fs').promises;
      const scriptPath = path.join(baseDir, folder, 'script.json');
      const s = JSON.parse(await fsp.readFile(scriptPath, 'utf8'));
      const cost = s.cost || {};
      const total = typeof cost.total === 'number' ? cost.total : 0;
      if (total <= 0) return;
      // Record ONE ledger row per provider (openai | replicate | …) so vendor
      // spend can be reported separately. Idempotent per (folder, category,
      // provider). If a folder predates byProvider, fall back to a single
      // openai-tagged row so nothing is lost.
      const byProvider = cost.byProvider && Object.keys(cost.byProvider).length
        ? cost.byProvider
        : { openai: total };
      for (const [provider, amount] of Object.entries(byProvider)) {
        if (!(amount > 0)) continue;
        await this.db.recordCost({ category, amount, detail: s.title || folder, ref: folder, provider });
      }
    } catch (e) {
      this.logger.warn(`Ledger record failed for ${folder}: ${e.message}`);
    }
  }

  // Build the scoreboard overlay object for a normalized WC match, downloading
  // (cache-first) the team crests to local files sharp can composite.
  async _buildMatchOverlay(match) {
    const wc = require('./utils/worldcup-provider');
    const [homeCrest, awayCrest] = await Promise.all([
      wc.getCrest(match.homeCrestUrl).catch(() => null),
      wc.getCrest(match.awayCrestUrl).catch(() => null),
    ]);
    // Include the tournament year (from the match date) for consistency with
    // the recap title, e.g. "FIFA World Cup 2026 · GROUP STAGE".
    const wcYear = match.utcDate ? new Date(match.utcDate).getUTCFullYear() : null;
    let comp = match.competition || 'FIFA World Cup';
    if (wcYear && !comp.includes(String(wcYear))) comp = `${comp} ${wcYear}`;
    return {
      homeTeam: match.homeTeam, awayTeam: match.awayTeam,
      homeScore: match.homeScore, awayScore: match.awayScore,
      homeCrest, awayCrest,
      label: `${comp}${match.stage ? ' · ' + String(match.stage).replace(/_/g, ' ') : ''}`,
    };
  }

  // Clean, relevant SEO for a match video. Short, valid tags (<=30 chars) built
  // from the teams/competition — no generic "tutorial/for beginners" template.
  // For Shorts, #Shorts leads the description (YouTube truncates after a trailing
  // hashtag block).
  _buildMatchSeo(match, script, { isShort = false } = {}) {
    const comp = match.competition || 'FIFA World Cup';
    const fixture = `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`;
    const tags = [
      match.homeTeam, match.awayTeam, 'World Cup', 'World Cup 2026',
      comp, 'football', 'soccer', 'match recap', 'highlights',
      `${match.homeTeam} vs ${match.awayTeam}`,
    ].filter(Boolean)
      .map(t => String(t).replace(/[<>":]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(t => t && t.length <= 30)
      .filter((t, i, a) => a.findIndex(x => x.toLowerCase() === t.toLowerCase()) === i)
      .slice(0, 15);

    const base = (script.hook && script.hook.text) ? script.hook.text : `${fixture} — ${comp} recap.`;
    // Shorts: lead with searchable football hashtags + team hashtags (fans search
    // these), not generic ones. Keep the fixture+comp line for entity/search.
    const teamTags = [match.homeTeam, match.awayTeam]
      .filter(Boolean).map(t => '#' + String(t).replace(/[^A-Za-z0-9]/g, ''));
    const hashLine = ['#Shorts', '#Football', '#Soccer', ...teamTags, '#WorldCup']
      .filter((h, i, a) => a.indexOf(h) === i).slice(0, 10).join(' ');
    const description = isShort
      ? `${hashLine}\n\n${base}\n\n${fixture} | ${comp}`
      : `${base}\n\n${fixture} | ${comp}\n\nAutomated match recap.`;

    return {
      title: (script.title || fixture).slice(0, 100),
      description,
      tags,
      metadata: { category: 17, language: 'en' }, // 17 = Sports
    };
  }

  // Persist the raw normalized match object (teams, scores, ids, dates) into a
  // folder as match.json. This is the audit trail for "what score did we use?":
  // without it, answering required re-querying the provider live. Best-effort.
  async _writeMatchJson(folderPath, match) {
    try {
      const fsp = require('fs').promises;
      await fsp.writeFile(
        path.join(folderPath, 'match.json'),
        JSON.stringify({ ...match, _savedAt: new Date().toISOString(), _source: 'football-data.org' }, null, 2)
      );
    } catch (e) { this.logger.warn(`match.json write failed: ${e.message}`); }
  }

  // Generate recap videos for one match: a long landscape recap and/or a short.
  // `formats` selects which (default both). Returns { long, short } folder info.
  // Does NOT upload — caller decides (scheduler auto-uploads unlisted).
  async generateMatchVideos(match, { formats = ['long', 'short'] } = {}) {
    const { CostMeter } = require('./utils/cost-meter');
    const shortsConfig = require('./utils/shorts-config');
    const gen = this.agents.production.aiVideoGenerator;
    const overlay = await this._buildMatchOverlay(match);
    const fixture = `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`;
    // Richer scene prompt: name the actual teams so the model renders the right
    // national kits, framed to avoid relying on a recognizable face.
    const visualPrompt = gen.buildSceneImagePrompt(
      `${fixture} — ${match.competition || 'FIFA World Cup'}`,
      { teams: { home: match.homeTeam, away: match.awayTeam },
        kits: { home: `${match.homeTeam}'s national team colours`, away: `${match.awayTeam}'s national team colours` } });
    const out = {};

    // ---- SHORT ----
    if (formats.includes('short')) {
      try {
        gen.costMeter = new CostMeter();
        const script = await this.agents.scriptWriter.generateMatchRecapScript(match, { format: 'short' });
        const images = [];
        for (let i = 0; i < shortsConfig.imageCount; i++) {
          const a = await gen.generateVisualAssets(visualPrompt, 'cinematic', 1,
            { size: shortsConfig.imageSize, quality: shortsConfig.imageQuality, format: 'short' });
          images.push(...a);
        }
        const seo = this._buildMatchSeo(match, script, { isShort: true });
        // Stock clips for recap Shorts use the GLOBAL default (no per-run override
        // on the scheduled/auto path). The scoreboard overlay coexists with the
        // clip/card composite (the assembler keeps the full-width scoreboard band).
        const clipOpts = await this._resolveClipOptions(null);
        const r = await this.shortsProducer.produce(script, images, { match: overlay, seo, ...clipOpts });
        await this._writeMatchJson(r.folderPath, match);
        await this._ledgerFolderCost(r.folder, 'match_recap', shortsConfig.outputDir);
        await this.db.upsertContent({ folder: r.folder, type: 'match_recap', title: script.title });
        out.short = { folder: r.folder, title: script.title };
        this.logger.info(`Match Short created: ${r.folder}`);
      } catch (e) { this.logger.error(`Match Short failed: ${e.message}`); out.shortError = e.message; }
    }

    // ---- LONG RECAP ---- (landscape, scoreboard overlay)
    if (formats.includes('long')) {
      try {
        gen.costMeter = new CostMeter();
        const script = await this.agents.scriptWriter.generateMatchRecapScript(match, { format: 'long' });
        const fsp = require('fs').promises;
        const { folderTimestamp } = require('./utils/timestamp');
        const slug = (script.title || fixture).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
        const folder = `${folderTimestamp()}_${slug}`;
        const folderPath = path.join(outputRoot(), folder);
        const assetsDir = path.join(folderPath, 'assets');
        await fsp.mkdir(assetsDir, { recursive: true });

        // One scene image per section.
        const sections = script.mainContent.sections;
        const images = [];
        for (let i = 0; i < sections.length; i++) {
          const a = await gen.generateVisualAssets(visualPrompt, 'cinematic', 1, { size: '1536x1024', quality: 'medium', format: 'long' });
          for (let j = 0; j < a.length; j++) {
            const dest = path.join(assetsDir, `visual_${images.length + 1}.png`);
            await fsp.copyFile(a[j], dest); images.push(dest);
          }
        }

        // TTS from the concatenated narration.
        const ttsText = [script.hook?.text, ...sections.map(s => s.content)].filter(Boolean).join(' ');
        await fsp.writeFile(path.join(folderPath, 'script_tts.txt'), ttsText);
        const narrationPath = path.join(folderPath, 'narration.mp3');
        let audioPath = null;
        try { await gen.generateTTSAudio(ttsText, narrationPath); audioPath = narrationPath; }
        catch (e) { this.logger.warn(`Recap TTS failed: ${e.message}`); }

        const videoPath = path.join(folderPath, 'video.mp4');
        await gen.generateVideo(script, images, audioPath, videoPath, { width: 1920, height: 1080, match: overlay });

        // Clean match-specific SEO (NOT the generic optimizer, which emits junk
        // long tags like "X tutorial / for beginners" that YouTube rejects).
        const seo = this._buildMatchSeo(match, script, { isShort: false });
        const scriptOut = { ...script, seo, cost: gen.costMeter.summary(),
          meta: { type: 'long', resolution: '1920x1080', durationSec: script.duration, matchRecap: true,
            models: { image: 'gpt-image-1', tts: gen.elevenLabsApiKey ? 'elevenlabs' : 'tts-1-hd' }, generatedAt: new Date().toISOString() } };
        await fsp.writeFile(path.join(folderPath, 'script.json'), JSON.stringify(scriptOut, null, 2));
        await this._writeMatchJson(folderPath, match);
        await this._ledgerFolderCost(folder, 'match_recap', outputRoot());
        await this.db.upsertContent({ folder, type: 'match_recap', title: script.title });
        out.long = { folder, title: script.title };
        this.logger.info(`Match recap created: ${folder}`);
      } catch (e) { this.logger.error(`Match recap failed: ${e.message}`); out.longError = e.message; }
    }

    return out;
  }

  async generateContent(topic = null, style = null, length = 'medium') {
    this.logger.info('Starting content generation pipeline...');

    // Fresh cost meter for this run; thumbnail, scene images, and TTS all run
    // through this same generator instance and get recorded against it.
    const { CostMeter } = require('./utils/cost-meter');
    this.agents.production.aiVideoGenerator.costMeter = new CostMeter();

    // Step 1: Strategy
    const strategy = await this.agents.strategy.generateContentStrategy(topic);
    this.logger.info(`Strategy generated: ${strategy.topic}`);
    
    // Step 2: Script Writing
    const script = await this.agents.scriptWriter.generateScript(strategy);
    this.logger.info(`Script generated: ${script.title}`);
    
    // Step 3: Thumbnail Design
    const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
    this.logger.info('Thumbnail generated');
    
    // Step 4: SEO Optimization
    const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
    this.logger.info('SEO optimization complete');
    
    // Step 5: Production Management
    const productionData = await this.agents.production.processContent({
      strategy,
      script,
      thumbnail,
      seo: seoData
    });
    this.logger.info('Production processing complete');
    
    // Step 6: Save to database
    const contentId = await this.db.saveProductionData(productionData);
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Record cost in the ledger + content index (folder = basename of outputDir).
    try {
      if (productionData.outputDir) {
        const folderName = path.basename(productionData.outputDir);
        await this._ledgerFolderCost(folderName, 'video', outputRoot());
        await this.db.upsertContent({ folder: folderName, type: 'long', title: script.title });
      }
    } catch (e) { this.logger.warn(`Long-video ledger record failed: ${e.message}`); }

    return {
      contentId,
      title: script.title,
      scheduledFor: productionData.scheduledPublishTime
    };
  }

  async start() {
    const initialized = await this.initialize();

    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }

    // Last-resort safety net: keep the long-running automation server alive when
    // an async error escapes a request (e.g. ERR_HTTP_HEADERS_SENT from a
    // client abort mid-stream, which Express middleware can't catch). Log it
    // instead of letting it crash the whole process. Not for the unrecoverable
    // case — a truly broken state should still be restarted by the operator.
    process.on('uncaughtException', (err) => {
      this.logger.error(`uncaughtException (kept alive): ${err.stack || err.message}`);
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error(`unhandledRejection (kept alive): ${reason && reason.stack ? reason.stack : reason}`);
    });
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      const autoOn = this.scheduler && this.scheduler.isEnabled;
      console.log(chalk.yellow(`\n🤖 Automation is ${autoOn ? 'ENABLED — scheduled jobs will run' : 'DISABLED by default — enable it from the Schedule tab'}.`));
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };