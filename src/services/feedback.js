const config = require('../config');

const FEEDBACK_TO = process.env.SOCIO_FEEDBACK_EMAIL || 'haiderali.dev95@gmail.com';

async function sendFeedback({ subject, message, user, score, reason, email }) {
  const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(FEEDBACK_TO)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      _subject: subject,
      subject,
      name: user,
      email,
      message: [
        `From: ${user}`,
        `Instance: ${config.baseUrl}`,
        score === null || score === undefined ? null : `AI usefulness score: ${score}/100`,
        reason ? `AI reason: ${reason}` : null,
        '',
        '---',
        message,
      ]
        .filter(Boolean)
        .join('\n'),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Email service error ${res.status}: ${data.message || res.statusText}`);
  }
  return data;
}

module.exports = { sendFeedback, FEEDBACK_TO };