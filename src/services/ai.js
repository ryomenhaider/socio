const config = require('../config');
const { getSetting, setSetting } = require('../db');

const TONES = {
  professional: 'professional and polished',
  casual: 'casual and friendly',
  funny: 'funny and witty',
  enthusiastic: 'energetic and enthusiastic',
  empathetic: 'empathetic and warm',
};

const AI_MODELS = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (fast & cheap)' },
  { id: 'openai/gpt-4o', label: 'GPT-4o (best quality)' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
];

const PLATFORM_IDS = ['linkedin', 'facebook', 'instagram', 'youtube', 'tiktok'];

const PLATFORM_LABELS = {
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};

function getModel() {
  return getSetting('openrouter_model') || config.openrouter.model;
}

function getKey() {
  return getSetting('openrouter_api_key') || config.openrouter.apiKey;
}

function hasKey() {
  return !!getKey();
}

function lenDesc(length) {
  return length === 'short'
    ? 'Short: 1-2 sentences'
    : length === 'long'
      ? 'Long: 4-6 sentences'
      : 'Medium: 2-4 sentences';
}

function buildPrompt({ topic, tone, length, platform }) {
  const toneDesc = TONES[tone] || TONES.professional;
  const len = lenDesc(length);
  switch (platform) {
    case 'linkedin':
      return [
        `You are a LinkedIn content writer. LinkedIn does not use captions — the text you write IS the post.`,
        `Write a LinkedIn post about: ${topic}.`,
        `Tone: ${toneDesc}. 120-250 words.`,
        `Short paragraphs separated by blank lines for readability. Thought-leadership style.`,
        `At most 3 relevant hashtags at the end. No emojis.`,
        `Output only the post text with no quotes, no preamble, no markdown.`,
      ].join(' ');
    case 'facebook':
      return [
        `You are a social media content writer. Write a Facebook post caption about: ${topic}.`,
        `Tone: ${toneDesc}. ${len}.`,
        `Conversational and engaging, as if written by a person, not a brand.`,
        `Include 3-5 relevant hashtags at the end.`,
        `Output only the caption text with no quotes, no preamble, no markdown.`,
      ].join(' ');
    case 'instagram':
      return [
        `You are an Instagram content writer. Write an Instagram caption about: ${topic}.`,
        `Tone: ${toneDesc}. ${len}.`,
        `First person and engaging, one sentence per line (use line breaks between sentences).`,
        `Include 5-8 relevant hashtags at the end.`,
        `Output only the caption text with no quotes, no preamble, no markdown.`,
      ].join(' ');
    case 'youtube':
      return [
        `You are a YouTube content writer. Write a video title and description about: ${topic}.`,
        `The title must be under 100 characters and click-worthy.`,
        `The description: 2-4 sentences, ${toneDesc}, with 3-5 relevant hashtags at the end.`,
        `Output exactly in this format with no preamble:`,
        `Title: <title>`,
        ``,
        `Description: <description>`,
      ].join('\n');
    case 'tiktok':
      return [
        `You are a TikTok content writer. Write a short, punchy TikTok caption about: ${topic}.`,
        `Tone: ${toneDesc}.`,
        `Under 200 characters total, hook in the first words, then 3-5 relevant hashtags.`,
        `Output only the caption text with no quotes, no preamble, no markdown.`,
      ].join(' ');
    default:
      return [
        `You are a social media content writer.`,
        `Write a ${toneDesc} caption about: ${topic}.`,
        `${len}.`,
        `Include 3-5 relevant hashtags at the end.`,
        `Output only the caption text with no quotes, no preamble, no markdown.`,
      ].join(' ');
  }
}

async function callLLM({ key, model, prompt, maxTokens }) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return text.trim();
}

function formatResult(platform, text) {
  const label = PLATFORM_LABELS[platform] || platform;
  if (platform === 'youtube') {
    const titleMatch = text.match(/^Title:\s*([^\n]+)/im);
    const descMatch = text.match(/Description:\s*([\s\S]+)$/i);
    if (titleMatch && descMatch) {
      return { platform, label, title: titleMatch[1].trim(), description: descMatch[1].trim() };
    }
  }
  return { platform, label, text };
}

async function generateCopy({ topic, tone, length, platforms, model }) {
  const key = getKey();
  if (!key) {
    throw new Error(
      'OpenRouter API key is not configured. Add OPENROUTER_API_KEY to .env and restart the service.'
    );
  }
  const ids = [].concat(platforms || []).filter((id) => PLATFORM_IDS.includes(id));
  if (ids.length === 0) {
    throw new Error('Select at least one platform to generate copy for.');
  }
  const m = model && AI_MODELS.some((x) => x.id === model) ? model : getModel();
  if (model && m === model) setSetting('openrouter_model', model);
  return Promise.all(
    ids.map(async (id) => {
      const text = await callLLM({
        key,
        model: m,
        prompt: buildPrompt({ topic, tone, length, platform: id }),
        maxTokens: 900,
      });
      return formatResult(id, text);
    })
  );
}

async function generateCaption({ topic, tone, length }) {
  const key = getKey();
  if (!key) {
    throw new Error(
      'OpenRouter API key is not configured. Add OPENROUTER_API_KEY to .env and restart the service.'
    );
  }
  return callLLM({
    key,
    model: getModel(),
    prompt: buildPrompt({ topic, tone, length, platform: null }),
    maxTokens: 400,
  });
}

module.exports = { AI_MODELS, generateCopy, generateCaption, hasKey, getModel };
