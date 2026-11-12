// Delivering a message: email through the Workers send_email binding (free
// to your own verified address), and an optional webhook.

import { EmailMessage } from "cloudflare:email";

function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 2047 encoded-words, only when the subject isn't plain ASCII. Each word
 *  stays under the 75-character limit; characters are never split. */
function encodeSubject(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = "";
  for (const ch of s) {
    if (new TextEncoder().encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

function addressOnly(a) {
  const m = /<([^>]+)>/.exec(a);
  return (m ? m[1] : a).trim();
}

/** A plain-text email as raw MIME. */
export function mime({ from: rawFrom, to: rawTo, subject, text }) {
  const from = String(rawFrom).replace(/[\r\n]+/g, " ");
  const to = String(rawTo).replace(/[\r\n]+/g, " ");
  const domain = addressOnly(from).split("@")[1] ?? "localhost";
  const body = b64(text.replace(/\r?\n/g, "\r\n")).replace(/.{76}(?=.)/g, "$&\r\n");
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    "",
  ].join("\r\n");
}

async function sendEmail(env, email, subject, text) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    throw new Error('The "EMAIL" send_email binding is missing from wrangler.jsonc.');
  }
  const raw = mime({ from: email.from, to: email.to, subject, text });
  await env.EMAIL.send(new EmailMessage(addressOnly(email.from), addressOnly(email.to), raw));
}

const slackEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Cuts to at most maxBytes of UTF-8 without splitting a character. */
export function cutBytes(s, maxBytes) {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

export function webhookRequest(webhook, subject, text, urgent) {
  switch (webhook.format) {
    case "discord":
      // Mentions off: alert text includes names and errors from APIs, never ping a channel.
      return { body: JSON.stringify({ content: `**${subject}**\n${text}`.slice(0, 2000), allowed_mentions: { parse: [] } }), headers: { "Content-Type": "application/json" } };
    case "slack":
      return { body: JSON.stringify({ text: slackEscape(`*${subject}*\n${text}`).slice(0, 39000) }), headers: { "Content-Type": "application/json" } };
    case "ntfy":
      return {
        // ntfy turns bodies over 4,096 bytes into attachments; headers must be Latin-1.
        body: new TextEncoder().encode(text).length > 4000 ? `${cutBytes(text, 3900)}\n...` : text,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Title: subject.replace(/[^\x20-\x7e]/g, "?").slice(0, 120),
          Priority: urgent ? "high" : "default",
          Tags: "warning",
        },
      };
    default:
      return { body: JSON.stringify({ subject, text, urgent }), headers: { "Content-Type": "application/json" } };
  }
}

async function sendWebhook(webhook, subject, text, urgent, fetchImpl) {
  const { body, headers } = webhookRequest(webhook, subject, text, urgent);
  const res = await fetchImpl(webhook.url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`the webhook answered HTTP ${res.status}`);
}

/**
 * Sends through every configured channel.
 * @returns {Promise<Array<{ channel: string, ok: boolean, error?: string }>>}
 */
export async function deliver(env, config, { subject, text, urgent = false }, fetchImpl = fetch) {
  const results = [];
  if (config.email) {
    try {
      await sendEmail(env, config.email, subject, text);
      results.push({ channel: "email", ok: true });
    } catch (err) {
      results.push({ channel: "email", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (config.webhook) {
    try {
      await sendWebhook(config.webhook, subject, text, urgent, fetchImpl);
      results.push({ channel: `webhook (${config.webhook.format})`, ok: true });
    } catch (err) {
      results.push({ channel: `webhook (${config.webhook.format})`, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
