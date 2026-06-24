const { google } = require('googleapis');
const fsPromises = require('fs').promises;
const fs = require('fs');
const sharp = require('sharp');

// YouTube rejects thumbnails over 2MB. Resize to the recommended 1280x720 and
// step JPEG quality down until the encoded buffer fits under the limit.
const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
async function compressThumbnailToLimit(thumbnailPath) {
  const original = await fsPromises.readFile(thumbnailPath);
  if (original.length <= YOUTUBE_THUMBNAIL_MAX_BYTES) return original;

  const base = sharp(thumbnailPath).resize(1280, 720, { fit: 'cover' });
  for (const quality of [90, 80, 70, 60, 50]) {
    const buf = await base.clone().jpeg({ quality }).toBuffer();
    if (buf.length <= YOUTUBE_THUMBNAIL_MAX_BYTES) return buf;
  }
  // Last resort: smallest acceptable quality.
  return base.clone().jpeg({ quality: 40 }).toBuffer();
}
const path = require('path');
const { Logger } = require('../utils/logger');

class PublishingSchedulingAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('PublishingScheduling');
    this.youtube = null;
    this.publishQueue = [];
  }

  async initialize() {
    this.logger.info('Initializing Publishing & Scheduling Agent...');
    await this.setupYouTubeAPI();
    await this.loadPublishQueue();
    return true;
  }

  async setupYouTubeAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube API initialized');
    } catch (error) {
      this.logger.warn('YouTube API not configured - publishing disabled');
      this.youtube = null;
    }
  }

  async loadPublishQueue() {
    try {
      const queue = await this.db.getPublishQueue();
      this.publishQueue = queue || [];
      this.logger.info(`Loaded ${this.publishQueue.length} items in publish queue`);
    } catch (error) {
      this.logger.warn('No existing publish queue found');
    }
  }

  async scheduleContent(productionData) {
    try {
      this.logger.info(`Scheduling content: ${productionData.id}`);
      
      const scheduleEntry = {
        productionId: productionData.id,
        title: productionData.script.title,
        publishTime: productionData.scheduledPublishTime,
        status: 'scheduled',
        priority: productionData.priority,
        metadata: {
          seo: productionData.seo,
          thumbnail: productionData.assets.thumbnail,
          video: productionData.assets.finalVideo,
          captions: productionData.assets.captions
        },
        createdAt: new Date().toISOString()
      };
      
      this.publishQueue.push(scheduleEntry);
      this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
      
      await this.db.saveScheduleEntry(scheduleEntry);
      
      this.logger.info(`Content scheduled for: ${scheduleEntry.publishTime}`);
      return scheduleEntry;
    } catch (error) {
      this.logger.error('Failed to schedule content:', error);
      throw error;
    }
  }

  async publishContent(contentId) {
    try {
      this.logger.info(`Publishing content: ${contentId}`);
      
      const scheduleEntry = this.publishQueue.find(entry => 
        entry.productionId === contentId || entry.id === contentId
      );
      
      if (!scheduleEntry) {
        throw new Error(`Content not found in queue: ${contentId}`);
      }
      
      // Upload video to YouTube
      const uploadResult = await this.uploadToYouTube(scheduleEntry);
      
      // Update database
      scheduleEntry.status = 'published';
      scheduleEntry.publishedAt = new Date().toISOString();
      scheduleEntry.youtubeId = uploadResult.id;
      scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
      
      await this.db.updateScheduleEntry(scheduleEntry);
      
      // Remove from queue
      this.publishQueue = this.publishQueue.filter(entry => entry.id !== scheduleEntry.id);
      
      this.logger.success(`Content published: ${scheduleEntry.youtubeUrl}`);
      return scheduleEntry;
    } catch (error) {
      this.logger.error('Failed to publish content:', error);
      throw error;
    }
  }

  /**
   * Sanitize tags for the YouTube API, which rejects "invalid video keywords":
   * - strip characters YouTube disallows in tags (< > and the colon/quotes that
   *   trigger rejection), collapse whitespace
   * - drop empties, cap each tag at 60 chars, dedupe
   * - keep total under YouTube's 500-char budget, cap at 25 tags
   */
  _sanitizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    const out = [];
    const seen = new Set();
    let total = 0;
    for (let raw of tags) {
      if (typeof raw !== 'string') continue;
      let t = raw.replace(/[<>"]/g, '').replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      // YouTube rejects overly long individual tags ("invalid video keywords").
      // Keep each tag <= 30 chars; skip (don't truncate) ones that are longer so
      // we never emit a mangled half-phrase.
      if (t.length > 30) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      // +1 accounts for the comma YouTube counts between tags.
      if (total + t.length + 1 > 480) break;
      seen.add(key);
      out.push(t);
      total += t.length + 1;
      if (out.length >= 25) break;
    }
    return out;
  }

  /**
   * Upload a generated output folder (output/<folder>/) directly to YouTube.
   * Builds SEO title/description/tags from the folder's script.json and reuses
   * the verified uploadToYouTube() path. Returns { videoId, url }.
   */
  async uploadOutputFolder(folderPath, { privacyStatus, force = false } = {}) {
    const path = require('path');
    const script = JSON.parse(await fsPromises.readFile(path.join(folderPath, 'script.json'), 'utf8'));

    const videoPath = path.join(folderPath, 'video.mp4');
    if (!fs.existsSync(videoPath)) {
      throw new Error('No video.mp4 in output folder; generate the video first.');
    }

    // Duplicate guard: if this folder was already uploaded, don't upload again
    // (unless force). Defense-in-depth beyond the WC seen-guard, so a retry or
    // re-run never double-posts the same video.
    const markerPath = path.join(folderPath, 'youtube_upload.json');
    if (!force && fs.existsSync(markerPath)) {
      try {
        const existing = JSON.parse(await fsPromises.readFile(markerPath, 'utf8'));
        if (existing && existing.videoId) {
          this.logger.info(`Skipping upload — already uploaded (${existing.url})`);
          return { videoId: existing.videoId, url: existing.url, alreadyUploaded: true };
        }
      } catch { /* unreadable marker → fall through and upload */ }
    }

    // Prefer SEO already built and stored in script.seo (Shorts embed their
    // own, including #Shorts). Only regenerate when no pre-built SEO exists,
    // so we never discard Shorts-specific tags/hashtags.
    let description, tags, category, language;
    if (script.seo && script.seo.description) {
      description = script.seo.description;
      tags = script.seo.tags || script.keywords || [];
      category = (script.seo.metadata && script.seo.metadata.category) || 17;
      language = (script.seo.metadata && script.seo.metadata.language) || 'en';
    } else {
      const strategy = (script.metadata && script.metadata.strategy) || {
        topic: script.title, angle: '', keywords: script.keywords || [],
        targetAudience: '', contentType: 'List'
      };
      tags = script.keywords || [];
      category = 17; language = 'en';
      try {
        const { SEOOptimizerAgent } = require('./seo-optimizer-agent');
        const seo = Object.create(SEOOptimizerAgent.prototype);
        description = await seo.generateDescription(script, strategy);
        tags = await seo.generateTags(script, strategy);
      } catch (e) {
        this.logger.warn(`SEO generation fell back to minimal metadata: ${e.message}`);
        description = (script.hook && script.hook.text) || script.title;
      }
    }

    // Shorts: YouTube ignores custom thumbnails (it auto-generates one from the
    // video) and a thumbnails.set call just burns API quota for nothing — so skip
    // it entirely for Shorts. Long videos still set their thumbnail.
    const isShort = script.format === 'short' ||
      (script.meta && script.meta.type === 'short');
    const thumbPath = path.join(folderPath, 'thumbnail.png');
    const capPath = path.join(folderPath, 'captions.srt');
    const scheduleEntry = {
      id: 'folder-' + Date.now(),
      // No publishTime: we publish immediately (publishAt requires privacy=private).
      metadata: {
        video: { path: videoPath, simulated: false },
        thumbnail: (!isShort && fs.existsSync(thumbPath)) ? { path: thumbPath } : null,
        captions: fs.existsSync(capPath) ? { path: capPath } : null,
        seo: {
          title: (script.title || 'Untitled').slice(0, 100),
          description,
          tags: this._sanitizeTags(tags),
          metadata: { category, language }
        }
      }
    };

    if (privacyStatus) {
      // Temporarily override the env default for this upload.
      scheduleEntry._privacyOverride = privacyStatus;
    }

    const result = await this.uploadToYouTube(scheduleEntry);
    const url = `https://www.youtube.com/watch?v=${result.id}`;

    // Record the upload in the folder so the dashboard can show "already
    // uploaded" and guard against accidental duplicate uploads.
    try {
      await fsPromises.writeFile(
        path.join(folderPath, 'youtube_upload.json'),
        JSON.stringify({
          videoId: result.id, url,
          privacy: privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'public',
          uploadedAt: new Date().toISOString()
        }, null, 2)
      );
    } catch (e) {
      this.logger.warn(`Could not write youtube_upload.json: ${e.message}`);
    }

    return { videoId: result.id, url };
  }

  async uploadToYouTube(scheduleEntry) {
    const { metadata } = scheduleEntry;
    
    // Verify we have a real video file, not a placeholder
    if (!metadata.video || !metadata.video.path) {
      throw new Error('No video file path available for upload');
    }

    if (metadata.video.simulated) {
      throw new Error('Cannot upload simulated video. Configure AI services to generate real video content.');
    }

    // Prepare video metadata
    const videoMetadata = {
      snippet: {
        title: metadata.seo.title,
        description: metadata.seo.description,
        tags: metadata.seo.tags,
        categoryId: metadata.seo.metadata.category.toString(),
        defaultLanguage: metadata.seo.metadata.language,
        defaultAudioLanguage: metadata.seo.metadata.language
      },
      status: {
        privacyStatus: scheduleEntry._privacyOverride || process.env.DEFAULT_PRIVACY_STATUS || 'public',
        // publishAt is only valid when privacyStatus is 'private'; omit otherwise
        // (YouTube rejects publishAt for public/unlisted uploads).
        ...(scheduleEntry.publishTime &&
            (scheduleEntry._privacyOverride || process.env.DEFAULT_PRIVACY_STATUS) === 'private'
            ? { publishAt: scheduleEntry.publishTime } : {}),
        selfDeclaredMadeForKids: false
      }
    };
    
    this.logger.info(`Uploading with privacyStatus=${videoMetadata.status.privacyStatus} (override=${scheduleEntry._privacyOverride || 'none'}, envDefault=${process.env.DEFAULT_PRIVACY_STATUS || 'none'})`);
    // Upload video file
    const videoUpload = await this.youtube.videos.insert({
      part: 'snippet,status',
      requestBody: videoMetadata,
      media: {
        body: await this.getVideoStream(metadata.video.path)
      }
    });
    
    const videoId = videoUpload.data.id;
    this.logger.info(`Video uploaded with ID: ${videoId}`);
    
    // Upload thumbnail
    if (metadata.thumbnail && metadata.thumbnail.path) {
      await this.uploadThumbnail(videoId, metadata.thumbnail.path);
    }
    
    // Upload captions
    if (metadata.captions && metadata.captions.path) {
      await this.uploadCaptions(videoId, metadata.captions.path);
    }
    
    return videoUpload.data;
  }

  async getVideoStream(videoPath) {
    // Handle simulation/placeholder files
    if (videoPath.endsWith('.assembly.json') || videoPath.endsWith('.info')) {
      throw new Error(`Cannot upload placeholder file: ${videoPath}. A real video file is required. Configure AI services to generate real video content.`);
    }
    
    // Verify file exists
    try {
      await fsPromises.access(videoPath);
    } catch {
      throw new Error(`Video file not found: ${videoPath}`);
    }
    
    return fs.createReadStream(videoPath);
  }

  async uploadThumbnail(videoId, thumbnailPath) {
    try {
      const thumbnailBuffer = await compressThumbnailToLimit(thumbnailPath);

      await this.youtube.thumbnails.set({
        videoId: videoId,
        media: {
          body: thumbnailBuffer
        }
      });
      
      this.logger.info(`Thumbnail uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload thumbnail: ${error.message}`);
    }
  }

  async uploadCaptions(videoId, captionsPath) {
    try {
      const captionsContent = await fsPromises.readFile(captionsPath, 'utf8');
      
      await this.youtube.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId: videoId,
            language: 'en',
            name: 'English Captions',
            isDraft: false
          }
        },
        media: {
          body: captionsContent
        }
      });
      
      this.logger.info(`Captions uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload captions: ${error.message}`);
    }
  }

  async processPublishQueue() {
    this.logger.info('Processing publish queue...');
    
    const now = new Date();
    const readyToPublish = this.publishQueue.filter(entry => {
      const publishTime = new Date(entry.publishTime);
      return publishTime <= now && entry.status === 'scheduled';
    });
    
    for (const entry of readyToPublish) {
      try {
        await this.publishContent(entry.productionId);
        this.logger.info(`Auto-published: ${entry.title}`);
      } catch (error) {
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
        // Mark as failed but don't stop processing other items
        entry.status = 'failed';
        entry.error = error.message;
        await this.db.updateScheduleEntry(entry);
      }
    }
    
    return readyToPublish.length;
  }

  async getUpcomingSchedule(days = 7) {
    const now = new Date();
    const endDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    return this.publishQueue
      .filter(entry => {
        const publishTime = new Date(entry.publishTime);
        return publishTime >= now && publishTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    // Analyze channel analytics to find optimal publish times
    const analytics = await this.getChannelAnalytics();
    const optimalTimes = this.calculateOptimalTimes(analytics);
    
    // Update scheduled content with better times
    for (const entry of this.publishQueue) {
      if (entry.status === 'scheduled') {
        const currentTime = new Date(entry.publishTime);
        const betterTime = this.findBetterTime(currentTime, optimalTimes);
        
        if (betterTime && betterTime.getTime() !== currentTime.getTime()) {
          entry.publishTime = betterTime.toISOString();
          await this.db.updateScheduleEntry(entry);
          this.logger.info(`Optimized publish time for: ${entry.title}`);
        }
      }
    }
  }

  async getChannelAnalytics() {
    try {
      // Get channel analytics for the last 30 days
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - (30 * 24 * 60 * 60 * 1000));
      
      const response = await this.youtube.channels.list({
        part: 'statistics',
        mine: true
      });
      
      // In a full implementation, you'd use YouTube Analytics API
      // For now, we'll return simulated data
      return {
        totalViews: response.data.items[0]?.statistics?.viewCount || 0,
        subscribers: response.data.items[0]?.statistics?.subscriberCount || 0,
        videos: response.data.items[0]?.statistics?.videoCount || 0,
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'], // Most active days
        optimalHours: [14, 15, 16, 20] // Most active hours
      };
    } catch (error) {
      this.logger.error('Failed to get channel analytics:', error);
      return {
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'],
        optimalHours: [14, 15, 16]
      };
    }
  }

  calculateOptimalTimes(analytics) {
    const { optimalDays, optimalHours } = analytics;
    
    return {
      bestDays: optimalDays,
      bestHours: optimalHours,
      worstDays: ['Monday', 'Friday'],
      worstHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]
    };
  }

  findBetterTime(currentTime, optimalTimes) {
    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = currentTime.getHours();
    
    // If current time is already optimal, return null
    if (optimalTimes.bestDays.includes(currentDay) && 
        optimalTimes.bestHours.includes(currentHour)) {
      return null;
    }
    
    // Find the next optimal time
    const nextOptimalTime = new Date(currentTime);
    
    // Try to find an optimal hour on the same day
    for (const hour of optimalTimes.bestHours) {
      if (hour > currentHour) {
        nextOptimalTime.setHours(hour, 0, 0, 0);
        if (optimalTimes.bestDays.includes(currentDay)) {
          return nextOptimalTime;
        }
      }
    }
    
    // Find next optimal day
    for (let i = 1; i <= 7; i++) {
      const testDate = new Date(currentTime.getTime() + (i * 24 * 60 * 60 * 1000));
      const testDay = testDate.toLocaleDateString('en-US', { weekday: 'long' });
      
      if (optimalTimes.bestDays.includes(testDay)) {
        testDate.setHours(optimalTimes.bestHours[0], 0, 0, 0);
        return testDate;
      }
    }
    
    return null; // No better time found
  }

  async createPublishingReport() {
    const report = {
      queueStatus: {
        total: this.publishQueue.length,
        scheduled: this.publishQueue.filter(e => e.status === 'scheduled').length,
        published: this.publishQueue.filter(e => e.status === 'published').length,
        failed: this.publishQueue.filter(e => e.status === 'failed').length
      },
      upcomingPublications: await this.getUpcomingSchedule(7),
      recentPublications: this.publishQueue
        .filter(e => e.status === 'published' && 
                new Date(e.publishedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      performance: await this.getPublishingPerformance(),
      generatedAt: new Date().toISOString()
    };
    
    return report;
  }

  async getPublishingPerformance() {
    const published = this.publishQueue.filter(e => e.status === 'published');
    
    if (published.length === 0) {
      return {
        totalPublished: 0,
        averageScheduleAccuracy: 0,
        publishingFrequency: 0
      };
    }
    
    // Calculate schedule accuracy
    let totalDelay = 0;
    let accuratePublishes = 0;
    
    published.forEach(entry => {
      const scheduledTime = new Date(entry.publishTime);
      const actualTime = new Date(entry.publishedAt);
      const delay = Math.abs(actualTime - scheduledTime) / (1000 * 60); // minutes
      
      totalDelay += delay;
      if (delay <= 5) accuratePublishes++; // Within 5 minutes is considered accurate
    });
    
    const averageDelay = totalDelay / published.length;
    const accuracyRate = (accuratePublishes / published.length) * 100;
    
    return {
      totalPublished: published.length,
      averageScheduleAccuracy: `${accuracyRate.toFixed(1)}%`,
      averageDelay: `${averageDelay.toFixed(1)} minutes`,
      publishingFrequency: this.calculatePublishingFrequency(published)
    };
  }

  calculatePublishingFrequency(published) {
    if (published.length < 2) return 'Insufficient data';
    
    const dates = published.map(p => new Date(p.publishedAt)).sort((a, b) => a - b);
    const totalDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
    const frequency = published.length / totalDays;
    
    if (frequency >= 1) return `${frequency.toFixed(1)} videos per day`;
    if (frequency >= 0.14) return `${(frequency * 7).toFixed(1)} videos per week`;
    return `${(frequency * 30).toFixed(1)} videos per month`;
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    // For urgent publishing needs
    this.logger.info(`Emergency publish requested: ${contentId}`);
    
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    if (delayMinutes > 0) {
      const newPublishTime = new Date(Date.now() + (delayMinutes * 60 * 1000));
      entry.publishTime = newPublishTime.toISOString();
      await this.db.updateScheduleEntry(entry);
      this.logger.info(`Emergency scheduled for: ${entry.publishTime}`);
      return entry;
    } else {
      return await this.publishContent(contentId);
    }
  }

  async pauseScheduledContent(contentId) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'paused';
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content paused: ${entry.title}`);
    return entry;
  }

  async resumeScheduledContent(contentId, newPublishTime = null) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'scheduled';
    if (newPublishTime) {
      entry.publishTime = new Date(newPublishTime).toISOString();
    }
    
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content resumed: ${entry.title}`);
    return entry;
  }
}

module.exports = { PublishingSchedulingAgent };