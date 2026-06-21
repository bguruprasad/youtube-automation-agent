const express = require('express');
const path = require('path');
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
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db);
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
      const filePath = path.join(__dirname, 'output', folder, file);
      res.sendFile(filePath, (err) => {
        if (err) {
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

    // List previous generations
    this.app.get('/outputs', async (req, res) => {
      try {
        const outputDir = path.join(__dirname, 'output');
        const fs = require('fs').promises;
        const dirs = await fs.readdir(outputDir).catch(() => []);
        const outputs = [];
        for (const dir of dirs) {
          try {
            const dirPath = path.join(outputDir, dir);
            const scriptPath = path.join(dirPath, 'script.json');
            const script = JSON.parse(await fs.readFile(scriptPath, 'utf8'));
            const files = await fs.readdir(dirPath);
            // Use the folder's modification time for true generation-order
            // sorting (folder names only carry a date, not a time).
            const stat = await fs.stat(dirPath);
            // Has this folder already been uploaded to YouTube?
            let uploaded = null;
            if (files.includes('youtube_upload.json')) {
              try { uploaded = JSON.parse(await fs.readFile(path.join(dirPath, 'youtube_upload.json'), 'utf8')); } catch {}
            }
            outputs.push({
              folder: dir,
              title: script.title,
              files: files.filter(f => !f.startsWith('.')),
              hasVideo: files.includes('video.mp4'),
              hasThumbnail: files.includes('thumbnail.png'),
              createdAt: script.createdAt || null,
              modifiedAt: stat.mtimeMs,
              uploaded, // { videoId, url, privacy, uploadedAt } or null
              cost: script.cost || null, // { total, byType, items, ... } or null
              meta: script.meta || null, // { resolution, durationSec, models, ... }
            });
          } catch { /* skip invalid dirs */ }
        }
        // Newest first by actual mtime.
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
        const folderPath = path.join(__dirname, 'output', folder);
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

        const result = await this.agents.publishing.uploadOutputFolder(folderPath, { privacyStatus: privacy });
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
        const folderPath = path.join(__dirname, shortsConfig.outputDir, folder);
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
        const result = await this.agents.publishing.uploadOutputFolder(folderPath, { privacyStatus: privacy });
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
      res.sendFile(path.join(__dirname, shortsConfig.outputDir, folder, file));
    });

    // List generated Shorts (output/shorts/).
    this.app.get('/shorts', async (req, res) => {
      try {
        const shortsConfig = require('./utils/shorts-config');
        const fsp = require('fs').promises;
        const shortsDir = path.join(__dirname, shortsConfig.outputDir);
        const dirs = await fsp.readdir(shortsDir).catch(() => []);
        const shorts = [];
        for (const dir of dirs) {
          try {
            const dirPath = path.join(shortsDir, dir);
            const script = JSON.parse(await fsp.readFile(path.join(dirPath, 'script.json'), 'utf8'));
            const files = await fsp.readdir(dirPath);
            const stat = await fsp.stat(dirPath);
            let uploaded = null;
            if (files.includes('youtube_upload.json')) {
              try { uploaded = JSON.parse(await fsp.readFile(path.join(dirPath, 'youtube_upload.json'), 'utf8')); } catch {}
            }
            shorts.push({
              folder: dir, title: script.title,
              hasVideo: files.includes('video.mp4'),
              modifiedAt: stat.mtimeMs, uploaded,
              cost: script.cost || null,
              meta: script.meta || null,
            });
          } catch {}
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
        const shortsConfig = require('./utils/shorts-config');
        const momentsProvider = require('./utils/football-moments-provider');
        const forced = req.body && req.body.moment;
        const moment = forced
          ? { title: forced, hint: '', recent: false }
          : await momentsProvider.getMoment({ logger: this.logger });

        this.logger.info(`Generating Short for moment: ${moment.title}`);
        const script = await this.agents.scriptWriter.generateShortScript(moment);

        // Start a fresh cost meter for this run (scene images + TTS recorded
        // against it; produce() embeds the summary into script.json).
        const { CostMeter } = require('./utils/cost-meter');
        this.agents.production.aiVideoGenerator.costMeter = new CostMeter();

        // Fresh portrait, low-quality images.
        const images = [];
        const visualPrompt = `${moment.title}. ${moment.hint || ''} Football/soccer, dramatic, cinematic.`;
        for (let i = 0; i < shortsConfig.imageCount; i++) {
          const assets = await this.agents.production.aiVideoGenerator.generateVisualAssets(
            visualPrompt, 'cinematic', 1,
            { size: shortsConfig.imageSize, quality: shortsConfig.imageQuality }
          );
          images.push(...assets);
        }

        const result = await this.shortsProducer.produce(script, images);
        res.json({ success: true, folder: result.folder, title: script.title, moment: moment.title });
      } catch (error) {
        this.logger.error('Short generation failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Mode B - Make a Short from an existing long-video output folder.
    this.app.post('/short-from/:folder', async (req, res) => {
      try {
        const folder = path.basename(req.params.folder);
        const srcPath = path.join(__dirname, 'output', folder);
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
        const result = await this.shortsProducer.produce(shortScript, images, {
          sourceThumb: require('fs').existsSync(srcThumb) ? srcThumb : null,
        });
        res.json({ success: true, folder: result.folder, title: shortScript.title, source: folder });
      } catch (error) {
        this.logger.error('Short-from-existing failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
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