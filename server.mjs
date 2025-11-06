// server.mjs (ESM)
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

let dotenvLoaded = false;
try { await import('dotenv/config'); dotenvLoaded = true; } catch {}

import sdk from 'microsoft-cognitiveservices-speech-sdk';
import OpenAI from 'openai';

// ---------------------- Express setup ----------------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

// ---------------------- Helpers ----------------------
function parseCatalog(txt) {
  // Parses lines like: "- Param156 — [0, 1] (default 0, step ~0.01) — Note"
  const lines = (txt || '').split(/\r?\n/);
  const items = [];
  for (const ln of lines) {
    const m = ln.match(/-\s*([A-Za-z0-9_]+)\s*—\s*\[(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\](?:\s*\(default\s*([-\d.]+).*?\))?(?:\s*—\s*(.*))?$/);
    if (!m) continue;
    const [, id, min, max, dflt, desc] = m;
    const note = (desc || '').toLowerCase();
    items.push({
      id,
      min: Number(min),
      max: Number(max),
      default: isFinite(Number(dflt)) ? Number(dflt) : 0,
      isToggleLike: /piecewise|toggle|categor/i.test(note),
      note: desc || ''
    });
  }
  return items;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function clampTimeline(timeline, defs) {
  if (!timeline) return timeline;
  const byId = new Map(defs.map(d => [d.id, d]));
  const clampMap = (obj) => {
    const out = {};
    for (const [k,v] of Object.entries(obj||{})) {
      const d = byId.get(k);
      if (!d || typeof v !== 'number') continue;
      let vv = clamp(v, d.min, d.max);
      if (d.isToggleLike) vv = Math.round(vv); // snap plateaus
      out[k] = vv;
    }
    return out;
  };
  if (timeline.mode === 'keyframes') {
    timeline.keyframes = (timeline.keyframes||[]).map(kf => ({
      timeMs: Math.max(0, Math.round(kf.timeMs||0)),
      params: clampMap(kf.params||kf.set||{})
    }));
  } else if (timeline.mode === 'fixed_fps' && timeline.fixedFps?.frames) {
    const dtMs = Math.max(8, Math.round(timeline.fixedFps.dtMs || 1000/60));
    timeline.fixedFps.dtMs = dtMs;
    timeline.fixedFps.frames = timeline.fixedFps.frames.map(f => clampMap(f));
  }
  return timeline;
}
function simpleFallbackTimeline({ words=[], visemes=[] }, defs, fps=60) {
  // Very subtle: eyebrow lifts on content words, blink at pauses, tiny head nods at sentence ends.
  const dtMs = Math.round(1000/Math.max(1, fps));
  const dur = Math.max(
    words.reduce((m,w)=>Math.max(m, w.endMs||0), 0),
    visemes.reduce((m,v)=>Math.max(m, v.startMs||0), 0)
  );
  const frames = [];
  const has = (id) => defs.some(d=>d.id===id);
  for (let t=0; t<=dur; t+=dtMs) {
    const f = {};
    // gentle breathing if available
    if (has('ParamBreath')) {
      f.ParamBreath = 0.5 + 0.1*Math.sin((t/1000)*2*Math.PI*0.33);
    }
    // tiny blink every ~3.5s
    if (has('ParamEyeLOpen') && has('ParamEyeROpen')) {
      const phase = Math.floor((t/3500)%1*10);
      if (phase===0) { f.ParamEyeLOpen = 0.1; f.ParamEyeROpen = 0.1; }
    }
    // nod at sentence ends (., !, ?)
    if (has('ParamAngleY')) {
      const end = words.find(w => /[.!?]/.test(w.text) && Math.abs((w.startMs||0)-t) < 200);
      if (end) f.ParamAngleY = 3.0;
    }
    frames.push(f);
  }
  return { mode:'fixed_fps', fixedFps:{ dtMs, frames } };
}

// ---------------------- Azure TTS setup ----------------------
const { SPEECH_KEY, SPEECH_REGION, ENDPOINT, OPENAI_API_KEY } = process.env;
if (!SPEECH_KEY) console.warn('WARN: SPEECH_KEY missing');
if (!SPEECH_REGION && !ENDPOINT) console.warn('WARN: SPEECH_REGION or ENDPOINT required');
if (!OPENAI_API_KEY) console.warn('WARN: OPENAI_API_KEY missing');
console.log('dotenv loaded:', dotenvLoaded, 'region:', SPEECH_REGION || '(via ENDPOINT)');

function makeSpeechConfig({ preferEndpoint = false } = {}) {
  if (preferEndpoint && ENDPOINT) {
    const cfg = sdk.SpeechConfig.fromEndpoint(new URL(ENDPOINT), SPEECH_KEY);
    return cfg;
  }
  if (!SPEECH_REGION) {
    if (!ENDPOINT) throw new Error('No SPEECH_REGION or ENDPOINT provided');
    const cfg = sdk.SpeechConfig.fromEndpoint(new URL(ENDPOINT), SPEECH_KEY);
    return cfg;
  }
  return sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
}
function azureFormatFromClient(fmt) {
  if ((fmt || '').toLowerCase().includes('mp3')) {
    return sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  }
  return sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
}
function ok(res, json) { return res.status(200).json(json); }
function fail(res, status, message, details) {
  return res.status(status).json({ error: 'TTS_ERROR', message, details });
}

// ---------------------- Health & voices ----------------------
app.get('/health', (req, res) => {
  ok(res, {
    status: 'ok',
    node: process.version,
    env: {
      SPEECH_KEY: !!SPEECH_KEY,
      SPEECH_REGION: SPEECH_REGION || null,
      ENDPOINT: ENDPOINT || null,
      OPENAI_API_KEY: !!OPENAI_API_KEY
    }
  });
});

app.get('/voices', async (req, res) => {
  try {
    const cfg = makeSpeechConfig();
    const result = await new Promise((resolve, reject) => {
      sdk.SpeechSynthesizer.getVoicesAsync(cfg, undefined, resolve, reject);
    });
    if (result.reason !== sdk.ResultReason.VoicesListRetrieved) {
      return fail(res, 502, 'Failed to retrieve voices', { reason: result.reason });
    }
    ok(res, { count: result.voices.length, voices: result.voices.map(v => v.name) });
  } catch (err) {
    fail(res, 500, err?.message || 'voices error', {
      name: err?.name, code: err?.code, stack: err?.stack
    });
  }
});

// ---------------------- TTS endpoint ----------------------
app.post('/tts', async (req, res) => {
  const { text, voice = 'en-US-JennyNeural', format = 'mp3', useEndpoint = false } = req.body || {};
  if (!text || typeof text !== 'string') return fail(res, 400, 'Missing "text"');

  let synthesizer;
  try {
    const speechConfig = makeSpeechConfig({ preferEndpoint: useEndpoint });
    speechConfig.speechSynthesisVoiceName = voice;
    speechConfig.speechSynthesisOutputFormat = azureFormatFromClient(format);

    synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    // capture timings
    const words = [];
    const visemes = [];
    synthesizer.synthesisWordBoundary = (_, e) => {
      const kind = e.boundaryType === sdk.SynthesisBoundaryType.Punctuation
        ? 'PunctuationBoundary' : 'WordBoundary';
      words.push({
        startMs: e.audioOffset / 10000,
        endMs: (e.audioOffset + e.duration) / 10000,
        text: e.text,
        boundaryType: kind
      });
    };
    synthesizer.visemeReceived = (_, e) => {
      visemes.push({ startMs: e.audioOffset / 10000, visemeId: e.visemeId });
    };

    const result = await new Promise((resolve, reject) => {
      synthesizer.speakTextAsync(text, resolve, reject);
    });

    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      const cancel = sdk.CancellationDetails.fromResult(result);
      const reason = cancel?.reason || 'Canceled';
      const code = cancel?.errorCode || 'Unknown';
      const details = cancel?.errorDetails || 'No details';
      return fail(res, 502, `Azure canceled: ${reason} (${code})`, { details });
    }

    const audioBase64 = Buffer.from(result.audioData).toString('base64');
    const mime = format.toLowerCase().includes('mp3') ? 'audio/mpeg' : 'audio/wav';
    return ok(res, { audioBase64, mime, words, visemes });

  } catch (err) {
    return fail(res, 500, err?.message || 'Internal error', {
      name: err?.name,
      code: err?.code || err?.statusCode,
      stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined
    });
  } finally {
    try { synthesizer?.close(); } catch {}
  }
});

// ---------------------- OpenAI client ----------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- Emotion scoring (Responses API with text.format + angry overrides)
app.post('/emotion', async (req, res) => {
  const { text = '' } = req.body || {};
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    // Pure JSON Schema (no "name" inside the schema object)
    const emotionSchema = {
      type: 'object',
      properties: {
        happiness: { type: 'number', minimum: 0, maximum: 1 },
        confused:  { type: 'number', minimum: 0, maximum: 1 },
        annoyed:   { type: 'number', minimum: 0, maximum: 1 },
        angry:     { type: 'number', minimum: 0, maximum: 1 },
        sad:       { type: 'number', minimum: 0, maximum: 1 }
      },
      required: ['happiness','confused','annoyed','angry','sad'],
      additionalProperties: false
    };

    const system = [
      'Return only a compact JSON object of normalized emotion intensities in [0,1].',
      'Emotions: happiness, confused, annoyed, angry, sad.',
      'No other keys. Be decisive for clear cues.'
    ].join('\n');

    const resp = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: system },
        { role: 'user',   content: text }
      ],
      // ✅ Correct location and required fields for Responses API:
      text: {
        format: {
          type: 'json_schema',
          name: 'EmotionScores',       // <-- required
          strict: true,
          schema: emotionSchema
        }
      },
      max_output_tokens: 512
    });

    let out = {};
    const raw = resp.output_text ?? '';
    if (raw) { try { out = JSON.parse(raw); } catch {} }

    // Rule-based overrides to guarantee obvious anger
    const angryHints = [
      /don'?t\s+piss\s+me\s+off/i,
      /\bi['’]?m\s+angry\b/i,
      /you'?re\s+one\s+of\s+those\s+delinquents/i
    ];
    if (angryHints.some(r => r.test(text))) {
      out.angry   = Math.max(0.9, Number(out.angry   ?? 0));
      out.annoyed = Math.max(0.6, Number(out.annoyed ?? 0));
      out.happiness = Math.min(Number(out.happiness ?? 0), 0.1);
      out.sad       = Math.min(Number(out.sad       ?? 0), 0.2);
      out.confused  = Math.min(Number(out.confused  ?? 0), 0.2);
    }

    const clamp01 = v => Math.min(1, Math.max(0, Number(v ?? 0)));
    return res.json({
      happiness: clamp01(out.happiness),
      confused:  clamp01(out.confused),
      annoyed:   clamp01(out.annoyed),
      angry:     clamp01(out.angry),
      sad:       clamp01(out.sad)
    });
  } catch (err) {
    console.error('emotion error:', err);
    return res.status(200).json({ happiness:0, confused:0, annoyed:0, angry:0, sad:0 });
  }
});

// ---- LIVE2D TIMELINE (planner) — use json_object instead of json_schema ----
app.post('/live2d_timeline', async (req, res) => {
  const { words = [], visemes = [], parameterCatalog = '', fps = 60, strategy = 'auto' } = req.body || {};
  if (!Array.isArray(words) || !Array.isArray(visemes)) {
    return res.status(400).json({ error:'BAD_INPUT', message:'words[] and visemes[] required' });
  }

  const defs = parseCatalog(parameterCatalog);
  if (!defs.length) {
    return res.json(simpleFallbackTimeline({ words, visemes }, [], fps));
  }

  const MAX_PARAMS = 280;
  const trimmed = defs.slice(0, MAX_PARAMS);
  const glossaryLines = trimmed.map(d =>
    `- ${d.id} [${d.min}, ${d.max}]${d.isToggleLike ? ' (toggle-like)' : ''}${d.note ? ` — ${d.note}` : ''}`
  ).join('\n');

  // Heuristic: force angry cues if obvious in text
  const lineText = (words || []).map(w => w?.text || '').join(' ');
  const hintAngry = /don'?t\s+piss\s+me\s+off/i.test(lineText)
                 || /\bi['’]?m\s+angry\b/i.test(lineText)
                 || /you'?re\s+one\s+of\s+those\s+delinquents/i.test(lineText);

  const system = [
    'You control a Live2D avatar by adjusting numeric parameters.',
    'Output a SINGLE JSON object with either:',
    '- Keyframes: {"mode":"keyframes","keyframes":[{"timeMs":<ms>,"params":{"<ParamId>":<number>}}, ...]}',
    '- OR fixed fps: {"mode":"fixed_fps","fixedFps":{"dtMs":<ms_per_frame>,"frames":[{"<ParamId>":<number>}, ...]}}',
    'Rules:',
    '• Use ONLY parameters from the glossary; keep values within [min,max].',
    '• Snap toggle-like params to integers. Do NOT set ParamMouthOpenY (audio drives mouth).',
    '• Use word/viseme timing for subtle brows/eyes/head/accessories.',
    '• Use punctuation (! ? .) for light nods/blinks; keep subtle.',
    '• If hints.angry is true, prefer visible anger cues (veins, stronger brow tilt) using available glossary params.',
    '',
    'Parameter glossary:',
    glossaryLines
  ].join('\n');

  const user = { words, visemes, fps, strategy, hints: { angry: !!hintAngry } };

  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    const resp = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: system },
        { role: 'user',   content: JSON.stringify(user) }
      ],
      // ✅ No schema — let the model return a JSON object, we validate/clamp locally.
      text: { format: { type: 'json_object' } },
      max_output_tokens: 5000
    });

    // Extract JSON safely
    let outJSON = null;
    const textOut = resp.output_text ?? '';
    if (textOut) { try { outJSON = JSON.parse(textOut); } catch {} }

    // Minimal shape checks; fallback if unusable
    const isFixed = outJSON && outJSON.mode === 'fixed_fps' && outJSON.fixedFps && Array.isArray(outJSON.fixedFps.frames);
    const isKeyed = outJSON && outJSON.mode === 'keyframes' && Array.isArray(outJSON.keyframes);
    if (!isFixed && !isKeyed) {
      const fb = simpleFallbackTimeline({ words, visemes }, trimmed, fps);
      return res.json(clampTimeline(fb, trimmed));
    }

    // Clamp to ranges; snap toggles; ensure sane dt/time
    const safe = clampTimeline(outJSON, trimmed);

    // Guard against empty payloads after clamping
    if (safe.mode === 'keyframes' && (!Array.isArray(safe.keyframes) || !safe.keyframes.length)) {
      const fb = simpleFallbackTimeline({ words, visemes }, trimmed, fps);
      return res.json(clampTimeline(fb, trimmed));
    }
    if (safe.mode === 'fixed_fps' && (!safe.fixedFps?.frames?.length)) {
      const fb = simpleFallbackTimeline({ words, visemes }, trimmed, fps);
      return res.json(clampTimeline(fb, trimmed));
    }

    return res.json(safe);
  } catch (err) {
    console.error('live2d_timeline error:', err);
    const fb = simpleFallbackTimeline({ words, visemes }, defs, fps);
    return res.status(200).json(clampTimeline(fb, defs));
  }
});

// ---------------------- Start ----------------------
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Live2D backend on http://localhost:${PORT}`);
});

