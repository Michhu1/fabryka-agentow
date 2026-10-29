import type { AppConfig } from '@app/config';
import nodemailer, { type SMTPTransportOptions } from 'nodemailer';

/** Sends one system email (password reset, invitation). */
export type Mailer = {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
};

/**
 * Transport options for the configured SMTP server. Implicit TLS only on port 465; other ports upgrade
 * with STARTTLS — required whenever credentials are sent, so an attacker on the network cannot strip
 * the server's STARTTLS offer and read the password (and the reset links) in plain text. Credentials
 * only when a user is set (e.g. Mailpit in dev needs none and stays plain SMTP). Logging stays off:
 * SMTP traffic contains the message bodies with reset links.
 */
export function smtpTransportOptions(smtp: AppConfig['smtp']): SMTPTransportOptions {
  const secure = smtp.port === 465;
  return {
    host: smtp.host,
    port: smtp.port,
    secure,
    requireTLS: Boolean(smtp.user) && !secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    // Nodemailer waits up to 2 minutes (connect) / 10 minutes (socket) by default.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    logger: false,
    debug: false,
  };
}

/**
 * The error a failed send is reported as: only nodemailer's error code (EENVELOPE, EAUTH, ECONNECTION…).
 * Its message and `response` are the SMTP server's reply text, which can contain the recipient address.
 */
export function smtpSendError(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  const reason = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unknown error';
  return new Error(`SMTP send failed (${reason})`);
}

export function createSmtpMailer(smtp: AppConfig['smtp']): Mailer {
  const transport = nodemailer.createTransport(smtpTransportOptions(smtp));
  return {
    async send(message) {
      try {
        await transport.sendMail({ from: smtp.from, ...message });
      } catch (error) {
        throw smtpSendError(error);
      }
    },
  };
}
