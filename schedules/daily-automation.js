const cron = require('node-cron');
const { Logger } = require('../utils/logger');

class DailyAutomation {
  constructor(agents, database, app = null) {
    this.agents = agents;
    this.db = database;
    this.app = app; // YouTubeAutomationAgent instance (for generateMatchVideos + uploads)
    this.logger = new Logger('DailyAutomation');
    this.scheduledTasks = new Map();
    this.isEnabled = true;

    // Static metadata for each task: cron expression (for display) + the method
    // to invoke. Drives both setupScheduledTasks() and "run now". Keys must match
    // the scheduledTasks Map keys.
    this.taskMeta = {
      'daily-content-generation': { cron: '0 6 * * *', label: 'Daily content generation (long video)', run: () => this.runDailyContentGeneration() },
      'daily-shorts-generation': { cron: '0 7 * * *', label: 'Daily Shorts generation', run: () => this.runDailyShortsGeneration() },
      'worldcup-match-videos': { cron: '*/30 * * * *', label: 'World Cup match videos (polls every 30 min; recap + Short ~30 min after full-time, auto-upload unlisted)', run: () => this.runWorldCupMatchVideos() },
      'comment-engagement': { cron: '0 */2 * * *', label: 'Comment engagement (drafts replies to new comments into the review queue every 2h)', run: () => this.runCommentEngagement() },
      'publish-queue-processing': { cron: '*/15 * * * *', label: 'Publish queue processing', run: () => this.processPublishQueue() },
      'daily-analytics':          { cron: '0 9 * * *',  label: 'Daily analytics', run: () => this.collectDailyAnalytics() },
      'weekly-strategy-review':   { cron: '0 8 * * 0',  label: 'Weekly strategy review', run: () => this.weeklyStrategyReview() },
      'daily-optimization':       { cron: '0 22 * * *', label: 'Daily optimization', run: () => this.runDailyOptimization() },
      'database-maintenance':     { cron: '0 3 * * 6',  label: 'Database maintenance', run: () => this.databaseMaintenance() },
    };
    // Last-run record per task: { at, status, detail }.
    this.lastRun = {};
    // Names of individually-disabled tasks (loaded from DB in initialize()).
    this.disabledTasks = new Set();
  }

  async initialize() {
    this.logger.info('Initializing daily automation scheduler...');

    // Automation is OFF by default for safety (scheduled generation can upload
    // PUBLIC to the live channel). The dashboard toggle persists this setting.
    const persisted = await this.db.getSetting('automation_enabled');
    this.isEnabled = persisted === 'true'; // unset/null => disabled
    this.logger.info(`Automation is ${this.isEnabled ? 'ENABLED' : 'DISABLED (default)'} on startup`);

    // Per-task disable set (persisted as a JSON array in setting
    // `disabled_tasks`). A task is skipped by cron if it's in here, even when the
    // master switch is ON. Tasks not listed default to enabled.
    try {
      const raw = await this.db.getSetting('disabled_tasks');
      this.disabledTasks = new Set(raw ? JSON.parse(raw) : []);
    } catch { this.disabledTasks = new Set(); }
    if (this.disabledTasks.size) {
      this.logger.info(`Disabled tasks: ${Array.from(this.disabledTasks).join(', ')}`);
    }

    await this.setupScheduledTasks();

    // Start monitoring loop
    this.startMonitoringLoop();

    this.logger.success('Daily automation initialized successfully');
    return true;
  }

  async setupScheduledTasks() {
    // Build each cron job from taskMeta. The wrapper gates on isEnabled and
    // records the run result in this.lastRun so the dashboard can show it.
    for (const [name, meta] of Object.entries(this.taskMeta)) {
      const job = cron.schedule(meta.cron, async () => {
        if (!this.isEnabled) {
          this.logger.info(`Skipping ${name} (automation disabled)`);
          return;
        }
        if (this.disabledTasks.has(name)) {
          this.logger.info(`Skipping ${name} (task disabled)`);
          return;
        }
        this.lastRun[name] = { at: new Date().toISOString(), status: 'running', detail: 'scheduled' };
        try {
          await meta.run();
          this.lastRun[name] = { at: new Date().toISOString(), status: 'success', detail: 'scheduled' };
        } catch (error) {
          this.lastRun[name] = { at: new Date().toISOString(), status: 'error', detail: error.message };
        }
      }, { scheduled: false });
      this.scheduledTasks.set(name, job);
    }

    // Start all scheduled tasks (the timer runs; the isEnabled gate decides
    // whether work actually happens, so the master toggle takes effect live).
    this.scheduledTasks.forEach((task, name) => {
      task.start();
      this.logger.info(`Started scheduled task: ${name} (${this.taskMeta[name].cron})`);
    });
  }

  async runDailyContentGeneration() {
    try {
      this.logger.info('Starting daily content generation...');
      
      const timer = this.logger.startTimer('Daily Content Generation');
      
      // Check if we should generate content today
      const shouldGenerate = await this.shouldGenerateContentToday();
      
      if (!shouldGenerate) {
        this.logger.info('Skipping content generation - sufficient content in pipeline');
        return;
      }

      // Generate content strategy
      const strategy = await this.agents.strategy.generateContentStrategy();
      this.logger.info(`Generated strategy: ${strategy.topic}`);

      // Generate script
      const script = await this.agents.scriptWriter.generateScript(strategy);
      this.logger.info(`Generated script: ${script.title}`);

      // Generate thumbnail
      const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
      this.logger.info('Generated thumbnail');

      // Optimize SEO
      const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
      this.logger.info('Completed SEO optimization');

      // Process through production
      const productionData = await this.agents.production.processContent({
        strategy,
        script,
        thumbnail,
        seo: seoData
      });
      this.logger.info(`Production completed: ${productionData.id}`);

      // Schedule for publishing
      await this.agents.publishing.scheduleContent(productionData);
      this.logger.info('Content scheduled for publishing');

      timer.end();
      this.logger.success('Daily content generation completed successfully');

      // Log the event
      await this.logAutomationEvent('daily_content_generation', 'success', {
        contentId: productionData.id,
        topic: strategy.topic,
        scheduledFor: productionData.scheduledPublishTime
      });

    } catch (error) {
      this.logger.error('Daily content generation failed:', error);
      
      await this.logAutomationEvent('daily_content_generation', 'error', {
        error: error.message
      });

      // Send notification about failure
      await this.sendFailureNotification('Daily Content Generation', error);
    }
  }

  // Generate N football Shorts (count from the `daily_shorts_count` DB setting,
  // default 1). Mirrors the /generate-short flow: moment -> short script ->
  // portrait images -> vertical assembly. Does NOT upload (publishing stays
  // manual / via the publish queue). Each Short is metered for cost.
  async runDailyShortsGeneration() {
    try {
      const count = parseInt(await this.db.getSetting('daily_shorts_count')) || 1;
      this.logger.info(`Starting daily Shorts generation (count=${count})...`);

      const shortsConfig = require('../utils/shorts-config');
      const momentsProvider = require('../utils/football-moments-provider');
      const { CostMeter } = require('../utils/cost-meter');
      const { ShortsProducer } = require('../utils/shorts-producer');
      const producer = new ShortsProducer(this.agents.production.aiVideoGenerator, this.logger);

      // Dedup: don't repeat a moment used recently (within this run OR the last
      // ~14 days). Persisted as a capped list of normalized titles.
      const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      let recent = [];
      try { recent = JSON.parse(await this.db.getSetting('recent_short_moments') || '[]'); } catch {}
      const usedSet = new Set(recent.map(norm));
      const persistRecent = async () =>
        this.db.setSetting('recent_short_moments', JSON.stringify(recent.slice(-60)), 'Recently used Short moment titles (dedup)');

      const made = [];
      for (let n = 0; n < count; n++) {
        try {
          // Try a few times to land on a moment we haven't used recently.
          let moment = null;
          for (let attempt = 0; attempt < 6; attempt++) {
            const cand = await momentsProvider.getMoment({ logger: this.logger });
            if (!usedSet.has(norm(cand.title))) { moment = cand; break; }
          }
          if (!moment) { this.logger.info(`Daily Short ${n + 1}/${count}: no fresh moment available, skipping`); continue; }
          usedSet.add(norm(moment.title));
          recent.push(moment.title);
          await persistRecent(); // persist before generating so a crash can't unmark it

          this.logger.info(`Daily Short ${n + 1}/${count}: ${moment.title}`);
          const script = await this.agents.scriptWriter.generateShortScript(moment);

          // Fresh meter per Short so each script.json gets its own cost.
          this.agents.production.aiVideoGenerator.costMeter = new CostMeter();

          const images = [];
          const visualPrompt = `${moment.title}. ${moment.hint || ''} Football/soccer, dramatic, cinematic.`;
          for (let i = 0; i < shortsConfig.imageCount; i++) {
            const assets = await this.agents.production.aiVideoGenerator.generateVisualAssets(
              visualPrompt, 'cinematic', 1,
              { size: shortsConfig.imageSize, quality: shortsConfig.imageQuality }
            );
            images.push(...assets);
          }

          const result = await producer.produce(script, images);
          // Ledger the cost (the app helper reads script.json; available via this.app).
          if (this.app && this.app._ledgerFolderCost) {
            const path = require('path');
            await this.app._ledgerFolderCost(result.folder, 'short', path.join(__dirname, '..', shortsConfig.outputDir));
          }
          made.push({ folder: result.folder, title: script.title });
        } catch (e) {
          this.logger.error(`Daily Short ${n + 1} failed: ${e.message}`);
        }
      }

      this.logger.success(`Daily Shorts generation completed: ${made.length}/${count} created`);
      await this.logAutomationEvent('daily_shorts_generation', 'success', { created: made.length, requested: count, shorts: made });
    } catch (error) {
      this.logger.error('Daily Shorts generation failed:', error);
      await this.logAutomationEvent('daily_shorts_generation', 'error', { error: error.message });
    }
  }

  // For each NEW finished World Cup match (since last run), generate a long recap
  // + a Short, then auto-upload both UNLISTED. A seen-guard (DB setting
  // `wc_processed_match_ids`) ensures each match yields videos exactly once.
  async runWorldCupMatchVideos() {
    try {
      if (!this.app || typeof this.app.generateMatchVideos !== 'function') {
        this.logger.warn('WC task: app reference unavailable; skipping');
        return;
      }
      const wc = require('../utils/worldcup-provider');
      const matches = await wc.getFinishedMatches({ logger: this.logger });
      if (!matches.length) { this.logger.info('WC task: no finished matches in window'); return; }

      // Seen-guard.
      let seen = [];
      try { seen = JSON.parse(await this.db.getSetting('wc_processed_match_ids') || '[]'); } catch {}
      const seenSet = new Set(seen);
      const fresh = matches.filter(m => !seenSet.has(m.id));
      if (!fresh.length) { this.logger.info('WC task: all finished matches already processed'); return; }

      this.logger.info(`WC task: ${fresh.length} new match(es) to process`);
      const privacy = (await this.db.getSetting('wc_upload_privacy')) || 'unlisted';
      const made = [];

      for (const match of fresh) {
        try {
          const result = await this.app.generateMatchVideos(match, { formats: ['long', 'short'] });

          // Auto-upload both (best-effort) at the configured privacy.
          if (result.long?.folder) {
            try {
              const fp = require('path').join(__dirname, '..', 'output', result.long.folder);
              await this.agents.publishing.uploadOutputFolder(fp, { privacyStatus: privacy });
            } catch (e) { this.logger.warn(`WC long upload failed: ${e.message}`); }
          }
          if (result.short?.folder) {
            try {
              const shortsConfig = require('../utils/shorts-config');
              const fp = require('path').join(__dirname, '..', shortsConfig.outputDir, result.short.folder);
              await this.agents.publishing.uploadOutputFolder(fp, { privacyStatus: privacy });
            } catch (e) { this.logger.warn(`WC short upload failed: ${e.message}`); }
          }

          seenSet.add(match.id);
          // Persist the seen-set IMMEDIATELY after each match (not just at the
          // end) so a crash/restart mid-loop can never cause a match to be
          // re-generated and re-uploaded.
          await this.db.setSetting('wc_processed_match_ids',
            JSON.stringify(Array.from(seenSet).slice(-200)), 'Processed World Cup match IDs (seen-guard)');
          made.push({ id: match.id, fixture: `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`, ...result });
        } catch (e) {
          this.logger.error(`WC match ${match.id} failed: ${e.message}`);
        }
      }

      this.logger.success(`WC task: processed ${made.length} match(es), uploaded ${privacy}`);
      await this.logAutomationEvent('worldcup_match_videos', 'success', { processed: made.length, privacy, matches: made });
    } catch (error) {
      this.logger.error('WC match videos task failed:', error);
      await this.logAutomationEvent('worldcup_match_videos', 'error', { error: error.message });
    }
  }

  // Scan own videos for new comments, classify + draft replies into the review
  // queue. Does NOT auto-post — replies are reviewed/approved in the dashboard
  // (review-first model). Spam/toxic are skipped, never engaged.
  async runCommentEngagement() {
    try {
      const eng = this.app && this.app.commentEngine;
      if (!eng || !eng.youtube) { this.logger.warn('Comment engagement: engine/YouTube not available'); return; }
      this.logger.info('Comment engagement: scanning for new comments...');
      const r = await eng.ingest({ maxVideos: 20, maxPerRun: 50 });
      this.logger.success(`Comment engagement: ${r.newComments} new across ${r.scannedVideos} videos ${JSON.stringify(r.byClass)}`);
      await this.logAutomationEvent('comment_engagement', 'success', { newComments: r.newComments, byClass: r.byClass });
    } catch (error) {
      this.logger.error('Comment engagement failed:', error);
      await this.logAutomationEvent('comment_engagement', 'error', { error: error.message });
    }
  }

  async shouldGenerateContentToday() {
    // Check content buffer
    const upcomingContent = await this.agents.publishing.getUpcomingSchedule(3);
    const bufferDays = parseInt(await this.db.getSetting('content_buffer_days')) || 3;
    
    // Check if we have enough content scheduled
    if (upcomingContent.length >= bufferDays) {
      return false;
    }

    // Check posting frequency settings
    const frequency = await this.db.getSetting('posting_frequency') || 'daily';
    const lastGeneration = await this.db.getSetting('last_content_generation');
    
    if (lastGeneration) {
      const lastDate = new Date(lastGeneration);
      const today = new Date();
      const daysSinceLastGeneration = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));
      
      switch (frequency) {
        case 'daily':
          return daysSinceLastGeneration >= 1;
        case 'every-2-days':
          return daysSinceLastGeneration >= 2;
        case '3-per-week':
          return daysSinceLastGeneration >= 2 || [1, 3, 5].includes(today.getDay());
        case 'weekly':
          return daysSinceLastGeneration >= 7;
        default:
          return true;
      }
    }

    return true;
  }

  async processPublishQueue() {
    try {
      const published = await this.agents.publishing.processPublishQueue();
      
      if (published > 0) {
        this.logger.info(`Published ${published} videos from queue`);
        
        await this.logAutomationEvent('queue_processing', 'success', {
          publishedCount: published
        });
      }
    } catch (error) {
      this.logger.error('Failed to process publish queue:', error);
      
      await this.logAutomationEvent('queue_processing', 'error', {
        error: error.message
      });
    }
  }

  async collectDailyAnalytics() {
    try {
      this.logger.info('Starting daily analytics collection...');
      
      // Get recently published videos
      const recentVideos = await this.getRecentlyPublishedVideos(7);
      
      let processedCount = 0;
      
      for (const video of recentVideos) {
        try {
          await this.agents.analytics.analyzeVideoPerformance(video.youtube_id);
          processedCount++;
          
          this.logger.info(`Analyzed video: ${video.title}`);
          
          // Small delay to avoid API rate limits
          await this.sleep(2000);
        } catch (error) {
          this.logger.error(`Failed to analyze video ${video.youtube_id}:`, error);
        }
      }

      this.logger.success(`Analytics collection completed. Processed ${processedCount} videos`);
      
      await this.logAutomationEvent('analytics_collection', 'success', {
        videosProcessed: processedCount
      });

    } catch (error) {
      this.logger.error('Daily analytics collection failed:', error);
      
      await this.logAutomationEvent('analytics_collection', 'error', {
        error: error.message
      });
    }
  }

  async weeklyStrategyReview() {
    try {
      this.logger.info('Starting weekly strategy review...');

      // Real review: derive patterns from actual upload performance (views +
      // cost-per-view) and get LLM recommendations. Persisted for the dashboard.
      const review = await this.agents.analytics.generateStrategyReview();

      if (review.hasData) {
        this.logger.info(`Strategy review: ${review.takeaways.join(' ')}`);
      } else {
        this.logger.info(`Strategy review: ${review.message}`);
      }

      // Try to optimize publishing times for any queued content (best-effort).
      try { await this.agents.publishing.optimizePublishTimes(); } catch (e) {
        this.logger.warn(`optimizePublishTimes skipped: ${e.message}`);
      }

      this.logger.success('Weekly strategy review completed');
      await this.logAutomationEvent('weekly_strategy_review', 'success', {
        takeaways: review.takeaways || [],
        recommendations: review.recommendations || [],
      });
    } catch (error) {
      this.logger.error('Weekly strategy review failed:', error);
      await this.logAutomationEvent('weekly_strategy_review', 'error', {
        error: error.message,
      });
    }
  }

  async runDailyOptimization() {
    try {
      this.logger.info('Starting daily optimization tasks...');
      
      // Optimize existing content SEO
      await this.optimizeExistingContent();
      
      // Update keyword performance data
      await this.updateKeywordPerformance();
      
      // Clean up old files
      await this.cleanupOldFiles();
      
      this.logger.success('Daily optimization completed');
      
      await this.logAutomationEvent('daily_optimization', 'success');

    } catch (error) {
      this.logger.error('Daily optimization failed:', error);
      
      await this.logAutomationEvent('daily_optimization', 'error', {
        error: error.message
      });
    }
  }

  async databaseMaintenance() {
    try {
      this.logger.info('Starting database maintenance...');
      
      // Create backup
      const backupPath = await this.db.backup();
      this.logger.info(`Database backed up to: ${backupPath}`);
      
      // Get database stats
      const stats = await this.db.getStats();
      this.logger.info(`Database stats: ${JSON.stringify(stats)}`);
      
      // Clean old analytics data (older than 90 days)
      await this.cleanOldAnalytics();
      
      this.logger.success('Database maintenance completed');
      
      await this.logAutomationEvent('database_maintenance', 'success', {
        backupPath,
        stats
      });

    } catch (error) {
      this.logger.error('Database maintenance failed:', error);
      
      await this.logAutomationEvent('database_maintenance', 'error', {
        error: error.message
      });
    }
  }

  // Helper methods
  async getRecentlyPublishedVideos(days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const rows = await this.db.getAllRows(
      `SELECT * FROM publish_schedule 
       WHERE status = 'published' AND published_at > ?
       ORDER BY published_at DESC`,
      [cutoffDate.toISOString()]
    );
    
    return rows;
  }

  async generateWeeklyInsights(analytics) {
    const insights = [];
    
    if (analytics.averagePerformanceScore > 80) {
      insights.push('Content performance is excellent this week');
    } else if (analytics.averagePerformanceScore < 50) {
      insights.push('Content performance needs improvement');
    }
    
    if (analytics.topPerformers.length > 0) {
      insights.push(`Best performing video: ${analytics.topPerformers[0].videoDetails.title}`);
    }
    
    return insights;
  }

  async optimizeExistingContent() {
    // Get videos published in last 30 days with low performance
    const lowPerformingVideos = await this.db.getAllRows(
      `SELECT ar.* FROM analytics_reports ar
       JOIN publish_schedule ps ON ar.video_id = ps.id
       WHERE ar.performance_score < 50 
       AND ps.published_at > datetime('now', '-30 days')
       LIMIT 5`
    );
    
    for (const video of lowPerformingVideos) {
      // Re-analyze and generate optimization suggestions
      await this.agents.analytics.analyzeVideoPerformance(video.video_id);
      this.logger.info(`Re-analyzed low performing video: ${video.video_id}`);
    }
  }

  async updateKeywordPerformance() {
    // Update keyword performance based on recent analytics
    const recentVideos = await this.getRecentlyPublishedVideos(7);
    
    for (const video of recentVideos) {
      const analyticsData = await this.db.getRow(
        'SELECT * FROM analytics_reports WHERE video_id = ?',
        [video.id]
      );
      
      if (analyticsData) {
        const videoDetails = JSON.parse(analyticsData.video_details);
        const keywords = videoDetails.tags || [];
        
        for (const keyword of keywords) {
          await this.db.updateKeywordPerformance(
            keyword,
            videoDetails.statistics.viewCount,
            video.youtube_id
          );
        }
      }
    }
  }

  async cleanupOldFiles() {
    // Clean up temporary files older than 7 days
    const fs = require('fs').promises;
    const path = require('path');
    
    const tempDir = path.join(__dirname, '..', 'temp');
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    
    try {
      await this.cleanDirectoryOldFiles(tempDir, 7);
      await this.cleanDirectoryOldFiles(uploadsDir, 30);
      this.logger.info('Old files cleaned up');
    } catch (error) {
      this.logger.error('Failed to clean up old files:', error);
    }
  }

  async cleanDirectoryOldFiles(directory, days) {
    const fs = require('fs').promises;
    const path = require('path');
    
    try {
      const files = await fs.readdir(directory);
      const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      // Directory might not exist, which is fine
    }
  }

  async cleanOldAnalytics() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    await this.db.executeQuery(
      'DELETE FROM analytics_reports WHERE analyzed_at < ?',
      [cutoffDate.toISOString()]
    );
  }

  async logAutomationEvent(eventType, status, data = {}) {
    await this.db.executeQuery(
      'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
      [eventType, status, JSON.stringify(data)]
    );
  }

  async sendFailureNotification(taskName, error) {
    // This would integrate with notification services (email, Slack, etc.)
    this.logger.error(`AUTOMATION FAILURE - ${taskName}: ${error.message}`);
    
    // Could send webhook notification, email, etc.
    // For now, just log it prominently
  }

  startMonitoringLoop() {
    // Monitor system health every hour
    setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error('Health check failed:', error);
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  async performHealthCheck() {
    const health = {
      timestamp: new Date().toISOString(),
      database: false,
      agents: {},
      scheduledTasks: {},
      systemResources: {}
    };

    // Check database
    try {
      await this.db.getAllRows('SELECT 1');
      health.database = true;
    } catch (error) {
      health.database = false;
    }

    // Check scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      health.scheduledTasks[name] = task.running;
    });

    // Get system resources (simplified)
    health.systemResources = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version
    };

    // Log health status
    const healthScore = this.calculateHealthScore(health);
    
    if (healthScore < 80) {
      this.logger.warn(`System health score: ${healthScore}/100`, health);
    } else {
      this.logger.info(`System health check passed: ${healthScore}/100`);
    }
    
    return health;
  }

  calculateHealthScore(health) {
    let score = 100;
    
    if (!health.database) score -= 30;
    
    const tasksRunning = Object.values(health.scheduledTasks).filter(Boolean).length;
    const totalTasks = Object.keys(health.scheduledTasks).length;
    
    if (totalTasks > 0 && tasksRunning < totalTasks) {
      score -= ((totalTasks - tasksRunning) / totalTasks) * 20;
    }
    
    return Math.max(0, Math.round(score));
  }

  // Control methods
  async pauseAutomation() {
    this.isEnabled = false;
    await this.db.setSetting('automation_enabled', 'false', 'Master switch for scheduled automation');
    this.logger.info('Automation paused');
  }

  async resumeAutomation() {
    this.isEnabled = true;
    await this.db.setSetting('automation_enabled', 'true', 'Master switch for scheduled automation');
    this.logger.info('Automation resumed');
  }

  // Enable/disable a single task (persisted). Does not affect the master switch
  // or "run now" — only whether cron auto-runs this task.
  async setTaskEnabled(name, enabled) {
    if (!this.taskMeta[name]) throw new Error(`Unknown task: ${name}`);
    if (enabled) this.disabledTasks.delete(name);
    else this.disabledTasks.add(name);
    await this.db.setSetting('disabled_tasks', JSON.stringify(Array.from(this.disabledTasks)),
      'Per-task automation disable list (task names)');
    this.logger.info(`Task ${name} ${enabled ? 'enabled' : 'disabled'}`);
    return { name, enabled };
  }

  // Run a single task immediately (dashboard "Run now"). Bypasses the isEnabled
  // gate (it's an explicit manual action) but records the result like a cron run.
  async runTaskNow(name) {
    const meta = this.taskMeta[name];
    if (!meta) throw new Error(`Unknown task: ${name}`);
    this.logger.info(`Manually running task: ${name}`);
    this.lastRun[name] = { at: new Date().toISOString(), status: 'running', detail: 'manual' };
    try {
      await meta.run();
      this.lastRun[name] = { at: new Date().toISOString(), status: 'success', detail: 'manual' };
      return this.lastRun[name];
    } catch (error) {
      this.lastRun[name] = { at: new Date().toISOString(), status: 'error', detail: error.message };
      throw error;
    }
  }

  async stopAutomation() {
    this.scheduledTasks.forEach((task, name) => {
      task.stop();
      this.logger.info(`Stopped scheduled task: ${name}`);
    });
    
    this.isEnabled = false;
    this.logger.info('All automation tasks stopped');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getAutomationStatus() {
    return {
      enabled: this.isEnabled,
      scheduledTasks: Array.from(this.scheduledTasks.keys()).map(name => {
        const meta = this.taskMeta[name] || {};
        return {
          name,
          label: meta.label || name,
          cron: meta.cron || null,
          nextRun: this._nextRun(meta.cron),
          running: this.scheduledTasks.get(name).running,
          taskEnabled: !this.disabledTasks.has(name),
          lastRun: this.lastRun[name] || null,
        };
      }),
      uptime: process.uptime(),
    };
  }

  // Compute the next fire time for a cron expression (display only). Supports the
  // simple field forms used here: '*', '*/n', and a single number per field.
  _nextRun(expr) {
    if (!expr) return null;
    const parts = expr.split(' ');
    if (parts.length !== 5) return null;
    const [mn, hr, dom, mon, dow] = parts;
    const match = (field, value, max, min = 0) => {
      if (field === '*') return true;
      if (field.startsWith('*/')) return value % parseInt(field.slice(2)) === 0;
      return parseInt(field) === value;
    };
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    // Scan forward up to ~366 days of minutes is too much; step by minute up to
    // 8 days (enough for daily/weekly schedules), else give up.
    for (let i = 0; i < 8 * 24 * 60; i++) {
      if (
        match(mn, d.getMinutes()) && match(hr, d.getHours()) &&
        match(dom, d.getDate()) && match(mon, d.getMonth() + 1) &&
        match(dow, d.getDay())
      ) return d.toISOString();
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }
}

module.exports = { DailyAutomation };