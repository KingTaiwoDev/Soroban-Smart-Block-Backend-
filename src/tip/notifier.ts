/**
 * Notification dispatcher: email (SMTP via env), Slack, Discord, Telegram,
 * and outbound webhooks with HMAC signing.
 */
import axios from 'axios';
import { createHmac } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { safePost } from '../webhooks/ssrf-guard';

const db = new PrismaClient();

export interface NotificationPayload {
  advisoryId: string;
  event: 'advisory.created' | 'advisory.updated' | 'advisory.resolved';
  title: string;
  severity: string;
  url?: string;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

export async function dispatchNotifications(payload: NotificationPayload): Promise<void> {
  const [subs, webhooks] = await Promise.all([
    db.tipSubscription.findMany({ where: { active: true } }),
    db.tipWebhook.findMany({ where: { active: true } }),
  ]);

  const filtered = subs.filter((s) => matchesFilter(s.filters as Record<string, unknown>, payload));

  await Promise.allSettled([
    ...filtered.map((s) => dispatch(s.channel, s.target, payload)),
    ...webhooks
      .filter((w) => w.events.includes(payload.event))
      .map((w) => sendWebhook(w.url, w.secret, payload)),
  ]);
}

async function dispatch(channel: string, target: string, p: NotificationPayload): Promise<void> {
  const text = formatMessage(p);
  switch (channel) {
    case 'slack':
      return sendSlack(target, text);
    case 'discord':
      return sendDiscord(target, text);
    case 'telegram':
      return sendTelegram(target, text);
    case 'email':
      return sendEmail(target, p.title, text);
  }
}

// ─── Channel senders ──────────────────────────────────────────────────────────

/**
 * POST JSON to a subscriber-supplied URL through the central outbound URL
 * policy (#1237). Throws on policy violations and non-2xx responses, matching
 * the previous axios behaviour so Promise.allSettled callers see failures.
 */
async function postJsonToSubscriber(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  const res = await safePost(
    url,
    JSON.stringify(payload),
    { 'Content-Type': 'application/json', ...headers },
    8_000,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Subscriber endpoint responded with HTTP ${res.status}`);
  }
}

async function sendSlack(webhookUrl: string, text: string): Promise<void> {
  await postJsonToSubscriber(webhookUrl, { text });
}

async function sendDiscord(webhookUrl: string, text: string): Promise<void> {
  await postJsonToSubscriber(webhookUrl, { content: text });
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown' },
    { timeout: 8_000 },
  );
}

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  // Email is opt-in. Requires nodemailer to be installed and SMTP env vars set.
  // If not configured, skip silently.
  if (!process.env.SMTP_HOST) return;
  // nodemailer is not a required dependency; install it and set SMTP_* vars to enable.
  // eslint-disable-next-line no-console
  logger.info(
    `[TIP] email skipped (nodemailer not installed): to=${to} subject=${subject} body=${body}`,
  );
}

// ─── Outbound webhook with HMAC ───────────────────────────────────────────────

async function sendWebhook(
  url: string,
  secret: string,
  payload: NotificationPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  await postJsonToSubscriber(url, payload, { 'X-TIP-Signature': `sha256=${sig}` });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMessage(p: NotificationPayload): string {
  return `🔐 [${p.severity.toUpperCase()}] ${p.title}\nEvent: ${p.event}\n${p.url ?? ''}`;
}

function matchesFilter(
  filters: { severity?: string[]; tags?: string[] } | null,
  p: NotificationPayload,
): boolean {
  if (!filters) return true;
  if (filters.severity?.length && !filters.severity.includes(p.severity)) return false;
  return true;
}
