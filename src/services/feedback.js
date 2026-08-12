const nodemailer = require('nodemailer');
const config = require('../config');

const FEEDBACK_TO = process.env.SOCIO_FEEDBACK_EMAIL || 'haiderali.dev95@gmail.com';

function mailConfigured() {
  return Boolean(config.mail.host && config.mail.user && config.mail.pass);
}

async function sendViaSmtp({ subject, message, user, email }) {
  const transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  await transporter.sendMail({
    from: config.mail.from || `"Socio feedback" <${config.mail.user}>`,
    to: FEEDBACK_TO,
    replyTo: email || config.mail.user,
    subject,
    text: message,
  });
  return { success: 'true' };
}

async function sendViaFormSubmit({ subject, message, user, score, reason, email }) {
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
    throw new Error(`FormSubmit error ${res.status}: ${data.message || res.statusText}`);
  }
  return data;
}

async function sendFeedback({ subject, message, user, score, reason, email }) {
  if (mailConfigured()) {
    return sendViaSmtp({ subject, message, user, email });
  }
  return sendViaFormSubmit({ subject, message, user, score, reason, email });
}

module.exports = { sendFeedback, FEEDBACK_TO, mailConfigured };