const config = require('../config');
const { getSetting } = require('../db');

const TONES = {
  professional: 'professional and polished',
  casual: 'casual and friendly',
  funny: 'funny and witty',
  enthusiastic: 'energetic and enthusiastic',
  empathetic: 'empathetic and warm',
};

function getModel() {
  return getSetting('openrouter_model') || config.openrouter.model;
}

function hasKey() {
  return !!(getSetting('openrouter_api_key') || config.openrouter.apiKey);
}

function buildPrompt({ topic, tone, length }) {
  const toneDesc = TONES[tone] || TONES.professional;
  const lenDesc =
    length === 'short'
      ? 'Short: 1-2 sentences'
      : length === 'long'
        ? 'Long: 4-6 sentences'
        : 'Medium: 2-4 sentences';
  return [
    `You are a social media content writer.`,
    `Write a ${toneDesc} caption about: ${topic}.`,
    `${lenDesc}.`,
    `Include 3-5 relevant hashtags at the end.`,
    `Output only the caption text with no quotes, no preamble, no markdown.`,
  ].join(' ');
}

async function generateCaption({ topic, tone, length }) {
  const key = getSetting('openrouter_api_key') || config.openrouter.apiKey;
  if (!key) {
    throw new Error('OpenRouter API key is not configured. Add it in Settings.');
  }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: getModel(),
      messages: [
        { role: 'user', content: buildPrompt({ topic, tone, length }) },
      ],
      temperature: 0.9,
      max_tokens: 400,
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

module.exports = { generateCaption, hasKey, getModel };
