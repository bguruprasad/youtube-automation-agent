// GenerationQueue: a single-worker, DB-persisted FIFO queue for heavy content
// generation (Shorts, match recaps, long videos). Only ONE job runs at a time,
// with a configurable delay between jobs, so concurrent ffmpeg/Flux runs don't
// thrash the machine (which was causing 15-min render timeouts that silently
// degraded clip/card scenes to plain stills).
//
// Persistence: jobs live in the `generation_queue` DB table, so a restart resumes
// pending work (and any job stuck 'running' from a crash is re-queued on start).
//
// Runners: the app registers a function per job `kind` via register(kind, fn).
// The worker claims the next pending job, looks up its runner, and calls
// fn(payload) -> result. Errors are recorded; the queue keeps going.

class GenerationQueue {
  /**
   * @param {object} db      Database instance (generation_queue helpers)
   * @param {object} logger
   * @param {object} opts    { delayMs }
   */
  constructor(db, logger, opts = {}) {
    this.db = db;
    this.logger = logger || console;
    this.delayMs = opts.delayMs != null ? opts.delayMs
      : parseInt(process.env.GEN_QUEUE_DELAY_MS || '8000', 10); // gap between jobs
    this.runners = new Map();   // kind -> async (payload, job) => result
    this._running = false;      // worker loop active
    this._current = null;       // currently-running job id
    this._stop = false;
  }

  // Register a runner for a job kind. fn receives (payload, job) and may return
  // a JSON-serializable result.
  register(kind, fn) { this.runners.set(kind, fn); return this; }

  // Enqueue a job. Returns { id, deduped }. Kicks the worker if idle.
  async enqueue({ kind, label = '', payload = {}, dedupKey = null }) {
    if (!this.runners.has(kind)) {
      this.logger.warn(`enqueue: no runner registered for kind "${kind}" (job will fail when claimed)`);
    }
    const r = await this.db.enqueueGeneration({ kind, label, payload, dedupKey });
    if (r.deduped) {
      this.logger.info(`Queue: skipped duplicate ${kind} (${label}) — already queued/running`);
    } else {
      this.logger.info(`Queue: enqueued #${r.id} ${kind} (${label})`);
    }
    this._kick();
    return r;
  }

  // Start the worker: recover stuck jobs, then process the backlog. Safe to call
  // once at boot; the loop self-sustains via _kick() on new enqueues.
  async start() {
    const recovered = await this.db.recoverStuckGenerations();
    if (recovered) this.logger.warn(`Queue: re-queued ${recovered} job(s) stuck 'running' from a prior crash`);
    try { await this.db.pruneGenerationQueue(); } catch {}
    this._kick();
  }

  stop() { this._stop = true; }

  // Internal: ensure the worker loop is running (no-op if already active).
  _kick() {
    if (this._running || this._stop) return;
    this._running = true;
    // Run the loop detached; never await it from callers.
    this._loop().catch((e) => {
      this.logger.error(`Queue loop crashed: ${e.message}`);
      this._running = false;
    });
  }

  async _loop() {
    while (!this._stop) {
      const job = await this.db.claimNextGeneration();
      if (!job) break; // queue drained
      this._current = job.id;
      const runner = this.runners.get(job.kind);
      const t = Date.now();
      this.logger.info(`Queue: ▶ running #${job.id} ${job.kind} (${job.label || ''})`);
      try {
        if (!runner) throw new Error(`no runner for kind "${job.kind}"`);
        const result = await runner(job.payload || {}, job);
        await this.db.completeGeneration(job.id, result || null);
        this.logger.info(`Queue: ✓ done #${job.id} ${job.kind} in ${((Date.now() - t) / 1000).toFixed(0)}s`);
      } catch (e) {
        await this.db.failGeneration(job.id, e.message);
        this.logger.error(`Queue: ✗ failed #${job.id} ${job.kind}: ${e.message}`);
      }
      this._current = null;
      // Gap between jobs so ffmpeg/CPU settles before the next heavy run.
      if (this.delayMs > 0 && !this._stop) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
    }
    this._running = false;
  }

  // Snapshot for the dashboard / status endpoint.
  async status() {
    const q = await this.db.getGenerationQueue();
    return { ...q, current: this._current, delayMs: this.delayMs, working: this._running };
  }
}

module.exports = { GenerationQueue };
