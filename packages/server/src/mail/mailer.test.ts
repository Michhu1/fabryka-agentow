import { describe, expect, it } from 'vitest';
import { smtpSendError, smtpTransportOptions } from './mailer.js';

const base = { host: 'smtp.example.com', port: 587, from: 'moj-n8n <no-reply@example.com>' };

describe('smtpTransportOptions', () => {
  it('uses implicit TLS only on port 465', () => {
    expect(smtpTransportOptions({ ...base, port: 465 }).secure).toBe(true);
    expect(smtpTransportOptions(base).secure).toBe(false);
    expect(smtpTransportOptions({ ...base, port: 1025 }).secure).toBe(false);
  });

  it('authenticates only when a user is set', () => {
    expect(smtpTransportOptions(base).auth).toBeUndefined();
    expect(smtpTransportOptions({ ...base, user: '', password: 'x' }).auth).toBeUndefined();
    expect(smtpTransportOptions({ ...base, user: 'u', password: 'p' }).auth).toEqual({
      user: 'u',
      pass: 'p',
    });
  });

  it('with credentials requires STARTTLS (no plain-text fallback) unless the port uses implicit TLS', () => {
    const auth = { user: 'u', password: 'p' };
    expect(smtpTransportOptions({ ...base, ...auth }).requireTLS).toBe(true);
    expect(smtpTransportOptions({ ...base, ...auth, port: 25 }).requireTLS).toBe(true);
    expect(smtpTransportOptions({ ...base, ...auth, port: 465 }).requireTLS).toBeFalsy();
    // Mailpit in dev: no user, plain SMTP on 1025.
    expect(smtpTransportOptions({ ...base, port: 1025 }).requireTLS).toBeFalsy();
  });

  it('never logs SMTP traffic (it contains reset links) and does not hang for minutes', () => {
    const options = smtpTransportOptions(base);
    expect(options.logger).toBe(false);
    expect(options.debug).toBe(false);
    expect(options.connectionTimeout).toBeLessThanOrEqual(30_000);
    expect(options.socketTimeout).toBeLessThanOrEqual(60_000);
  });
});

describe('smtpSendError', () => {
  it('keeps only the nodemailer error code, never the SMTP server response', () => {
    const rejected = Object.assign(
      new Error("Can't send mail - all recipients were rejected: 550 jan@example.pl"),
      {
        code: 'EENVELOPE',
        response: '550 5.1.1 <jan@example.pl>: Recipient address rejected',
        command: 'RCPT TO',
      },
    );
    const error = smtpSendError(rejected);
    expect(error.message).toBe('SMTP send failed (EENVELOPE)');
    expect(error.message).not.toContain('example.pl');
    expect(error.cause).toBeUndefined();
  });

  it('does not fall back to the message when there is no usable code', () => {
    const noCode = new Error('550 <jan@example.pl> rejected');
    expect(smtpSendError(noCode).message).toBe('SMTP send failed (unknown error)');
    expect(smtpSendError(Object.assign(new Error('x'), { code: 'jan@example.pl' })).message).toBe(
      'SMTP send failed (unknown error)',
    );
    expect(smtpSendError(undefined).message).toBe('SMTP send failed (unknown error)');
  });
});
