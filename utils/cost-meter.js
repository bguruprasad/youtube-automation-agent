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

  // OpenAI TTS narration. chars = input length, model tts-1 | tts-1-hd.
  recordOpenAITTS(chars, model = 'tts-1-hd', { label = 'TTS narration' } = {}) {
    const rate = TTS_RATES[model] ?? TTS_RATES['tts-1-hd'];
    this._add('tts', label, `${chars} chars @ ${model}`, (chars / 1000) * rate);
  }

  // ElevenLabs TTS. Credit-based, so $ is recorded as 0 with a provider note.
  recordElevenLabsTTS(chars, { label = 'TTS narration' } = {}) {
    this._add('tts', label, `${chars} chars (ElevenLabs credits)`, 0, 'elevenlabs');
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
    let total = 0;
    for (const it of this.items) {
      byType[it.type] = Number(((byType[it.type] || 0) + it.cost).toFixed(4));
      total += it.cost;
    }
    return {
      total: Number(total.toFixed(4)),
      currency: 'USD',
      byType,                 // { image, tts, llm }
      items: this.items,      // detailed line items
      meteredAt: new Date().toISOString(),
      note: 'Estimated from published API rates; ElevenLabs TTS billed via credits (not included in $).',
    };
  }
}

module.exports = { CostMeter };
