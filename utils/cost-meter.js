// Per-run cost meter. Each billable API call records a line item; totals are
// persisted into the run's script.json (`cost` field) and surfaced in the
// dashboard's (i) info panel.
//
// Prices are USD and approximate published OpenAI rates (update RATES as they
// change). gpt-image-1 is billed per image by size x quality; OpenAI TTS by
// character; chat models by token. ElevenLabs TTS is credit/subscription based
// (not pay-per-call), so we record characters but mark the $ as provider-billed.

// gpt-image-1 per-image price by "WIDTHxHEIGHT|quality". Square/portrait/
// landscape at the three quality tiers. Values in USD/image.
const IMAGE_RATES = {
  '1024x1024|low': 0.011, '1024x1024|medium': 0.042, '1024x1024|high': 0.167,
  '1024x1536|low': 0.016, '1024x1536|medium': 0.063, '1024x1536|high': 0.25,
  '1536x1024|low': 0.016, '1536x1024|medium': 0.063, '1536x1024|high': 0.25,
};
const IMAGE_RATE_FALLBACK = 0.042; // medium 1024x1024 if size/quality unknown

// OpenAI TTS: USD per 1K characters.
const TTS_RATES = { 'tts-1': 0.015, 'tts-1-hd': 0.030 };

// Chat models: USD per 1M tokens [input, output].
const LLM_RATES = {
  'gpt-4o-mini': [0.15, 0.60],
  'gpt-4o': [2.50, 10.00],
};

class CostMeter {
  constructor() {
    this.items = []; // { type, label, detail, cost, provider }
  }

  _add(type, label, detail, cost, provider = 'openai') {
    this.items.push({ type, label, detail, cost: Number(cost.toFixed(4)), provider });
  }

  // One generated image. size like "1536x1024", quality low|medium|high.
  recordImage(size, quality, { count = 1, label = 'Image' } = {}) {
    const rate = IMAGE_RATES[`${size}|${quality}`] ?? IMAGE_RATE_FALLBACK;
    this._add('image', label, `${count}x ${size} ${quality}`, rate * count);
  }

  // A generated image billed at a flat per-image rate (e.g. Replicate Flux).
  recordFlatImage(rate, { count = 1, label = 'Image', provider = 'replicate', detail = '' } = {}) {
    this._add('image', label, detail || `${count}x @ $${rate}`, rate * count, provider);
  }

  // OpenAI TTS narration. chars = input length, model tts-1 | tts-1-hd.
  recordOpenAITTS(chars, model = 'tts-1-hd', { label = 'TTS narration' } = {}) {
    const rate = TTS_RATES[model] ?? TTS_RATES['tts-1-hd'];
    this._add('tts', label, `${chars} chars @ ${model}`, (chars / 1000) * rate);
  }

  // ElevenLabs TTS. Credit-based, so $ is recorded as 0 with a provider note.
  recordElevenLabsTTS(chars, { label = 'TTS narration' } = {}) {
    this._add('tts', label, `${chars} chars (ElevenLabs credits)`, 0, 'elevenlabs');
  }

  // Pexels stock clip. Free tier (license-free, no per-call charge), so $0 with
  // a provider note — keeps the per-vendor dashboard honest about what was used.
  recordStockClip(query, { count = 1, label = 'Stock clip' } = {}) {
    this._add('clip', label, `${count}x "${query}" (Pexels free)`, 0, 'pexels');
  }

  // Chat/LLM call. usage = OpenAI usage object { prompt_tokens, completion_tokens }.
  recordLLM(model, usage, { label = 'LLM' } = {}) {
    const [inRate, outRate] = LLM_RATES[model] || LLM_RATES['gpt-4o-mini'];
    const inTok = usage?.prompt_tokens || 0;
    const outTok = usage?.completion_tokens || 0;
    const cost = (inTok / 1e6) * inRate + (outTok / 1e6) * outRate;
    this._add('llm', label, `${inTok}+${outTok} tok @ ${model}`, cost);
  }

  // Serializable summary written into script.json.
  summary() {
    const byType = {};
    const byProvider = {};
    let total = 0;
    for (const it of this.items) {
      byType[it.type] = Number(((byType[it.type] || 0) + it.cost).toFixed(4));
      const prov = it.provider || 'openai';
      byProvider[prov] = Number(((byProvider[prov] || 0) + it.cost).toFixed(4));
      total += it.cost;
    }
    return {
      total: Number(total.toFixed(4)),
      currency: 'USD',
      byType,                 // { image, tts, llm }
      byProvider,             // { openai, replicate, elevenlabs } — vendor split
      items: this.items,      // detailed line items
      meteredAt: new Date().toISOString(),
      note: 'Estimated from published API rates; ElevenLabs TTS billed via credits (not included in $).',
    };
  }
}

// Reconstruct an estimated cost for an already-generated folder that predates
// live metering. Reads what's recoverable from disk:
//   - image count  : assets/*.png (scene images) + thumbnail.png
//   - TTS chars    : script_tts.txt length
// Image size/quality are inferred from format (matches the params the pipeline
// actually used). Returns a cost summary with `backfilled:true`, or null if the
// folder lacks the inputs. Synchronous (uses fs sync) for simple script use.
function estimateFromFolder(folderPath, { format = 'long' } = {}) {
  const fs = require('fs');
  const path = require('path');
  const meter = new CostMeter();

  // Scene images. Skip sub-1KB files: those are placeholder PNGs written when
  // image generation fell back to simulation (e.g. a 429), so they were never
  // actually billed. (Same >1000-byte "valid asset" threshold the assembler uses.)
  let sceneCount = 0;
  try {
    const dir = path.join(folderPath, 'assets');
    sceneCount = fs.readdirSync(dir)
      .filter((f) => /\.png$/i.test(f))
      .filter((f) => { try { return fs.statSync(path.join(dir, f)).size > 1000; } catch { return false; } })
      .length;
  } catch { /* no assets dir */ }

  const isShort = format === 'short';
  const sceneSize = isShort ? '1024x1536' : '1536x1024';
  const sceneQual = isShort ? 'low' : 'medium';
  if (sceneCount > 0) {
    meter.recordImage(sceneSize, sceneQual, { count: sceneCount, label: 'Scene image' });
  }

  // Thumbnail (long videos generate a fresh high-quality one; shorts reuse a
  // frame, so no separate charge). Skip placeholders (sub-1KB).
  if (!isShort) {
    const thumb = path.join(folderPath, 'thumbnail.png');
    let thumbReal = false;
    try { thumbReal = fs.statSync(thumb).size > 1000; } catch {}
    if (thumbReal) meter.recordImage('1536x1024', 'high', { label: 'Thumbnail' });
  }

  // TTS narration.
  let chars = 0;
  try { chars = fs.statSync(path.join(folderPath, 'script_tts.txt')).size; } catch {}
  if (chars > 0) meter.recordOpenAITTS(chars, 'tts-1-hd');

  if (!meter.items.length) return null;
  const summary = meter.summary();
  summary.backfilled = true;
  summary.note = 'Estimated retroactively from on-disk assets (image count + TTS ' +
    'length) using published API rates. Not from live metering.';
  return summary;
}

module.exports = { CostMeter, estimateFromFolder };
