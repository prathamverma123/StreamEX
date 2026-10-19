import nodemailer, { Transporter } from 'nodemailer';
import { loadEnv } from '../config/env.js';
import { getLogger } from './logger.js';

/**
 * Mail delivery.
 *
 * MAIL_TRANSPORT=console → emails are logged to stdout (dev + test).
 * MAIL_TRANSPORT=smtp    → real SMTP via nodemailer.
 *
 * All sends are fire-and-forget from the request path: failures are logged
 * and surfaced through the returned promise, never thrown into a request.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let cachedTransport: Transporter | null | undefined;

function getTransport(): Transporter | null {
  if (cachedTransport !== undefined) return cachedTransport;
  const env = loadEnv();
  if (env.MAIL_TRANSPORT === 'smtp' && env.SMTP_HOST) {
    cachedTransport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
    });
  } else {
    cachedTransport = null;
  }
  return cachedTransport;
}

/** Reset cached transport (tests). */
export function resetMailTransport(): void {
  cachedTransport = undefined;
}

export async function sendMail(message: MailMessage): Promise<{ delivered: boolean }> {
  const log = getLogger();
  const transport = getTransport();
  if (!transport) {
    log.info(
      { to: message.to, subject: message.subject },
      '[mail:console] --------------------------------------------------',
    );
    log.info({ body: message.text }, '[mail:console] message body');
    return { delivered: false };
  }
  try {
    await transport.sendMail({
      from: loadEnv().SMTP_FROM,
      ...message,
    });
    return { delivered: true };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err }, 'smtp send failed');
    return { delivered: false };
  }
}

/** Password-reset email body. */
export function passwordResetEmail(resetUrl: string, ttlMinutes: number) {
  const text = `Reset your StreamEX password with this link (valid ${ttlMinutes} minutes):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`;
  const html = `<p>Reset your StreamEX password with this link (valid ${ttlMinutes} minutes):</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>If you did not request this, ignore this email.</p>`;
  return { text, html };
}

/** Welcome email body. */
export function welcomeEmail(name: string) {
  const text = `Welcome to StreamEX, ${name}!\n\nYour account is ready. Sign in and create your first profile.`;
  const html = `<p>Welcome to StreamEX, ${name}!</p><p>Your account is ready. Sign in and create your first profile.</p>`;
  return { text, html };
}
