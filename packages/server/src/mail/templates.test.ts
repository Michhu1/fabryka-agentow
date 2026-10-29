import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  invitationEmail,
  passwordResetEmail,
  projectInvitationEmail,
  projectTransferEmail,
} from './templates.js';

const LINK = 'http://localhost:5681/reset-password?token=abc.def&x=1';

describe('passwordResetEmail', () => {
  it('has a Polish subject and the link in both versions, escaped in HTML', () => {
    const mail = passwordResetEmail(LINK);
    expect(mail.subject).toMatch(/hasł/i);
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain('http://localhost:5681/reset-password?token=abc.def&amp;x=1');
    expect(mail.html).not.toContain('&x=1');
    expect(mail.text).toContain('20 minut');
    expect(mail.html).toContain('20 minut');
  });
});

describe('invitationEmail', () => {
  it('has the link in both versions and escapes the inviter name in HTML', () => {
    const link = 'http://localhost:5681/accept-invite?token=xyz';
    const mail = invitationEmail(link, '<b>x</b>');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(link);
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.text).toContain('<b>x</b>');
    expect(mail.text).toContain('7 dni');
    // The inviter's name is user input: it never goes into the subject header.
    expect(mail.subject).not.toContain('x</b>');
  });

  it('a link with a quote cannot break out of the href attribute', () => {
    const mail = invitationEmail('http://a/"><script>alert(1)</script>', 'Jan');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe.each([
  ['projectInvitationEmail', projectInvitationEmail, '/project-invitation?token=abc'],
  ['projectTransferEmail', projectTransferEmail, '/project-transfer?token=abc'],
] as const)('%s', (_name, template, path) => {
  const link = `http://localhost:5681${path}`;

  it('is Polish, names the project and the sender, states the 7 days and has the link in both versions', () => {
    const mail = template(link, 'Anna Adamska', 'Marketing');
    expect(mail.subject).toMatch(/projekt/);
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain(link);
      expect(body).toContain('Anna Adamska');
      expect(body).toContain('Marketing');
      expect(body).toContain('7 dni');
      // One text for everybody: it never depends on whether the address has an account.
      expect(body).toContain('Jeśli nie masz jeszcze konta');
    }
  });

  it('escapes the names in HTML and keeps them out of the subject', () => {
    const mail = template(link, '<b>Anna</b>', '<img src=x onerror=alert(1)>');
    expect(mail.html).not.toContain('<b>Anna</b>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(mail.text).toContain('<b>Anna</b>');
    expect(mail.subject).not.toMatch(/Anna|img/);
  });

  it('a link with a quote cannot break out of the href attribute', () => {
    const mail = template('http://a/"><script>alert(1)</script>', 'Jan', 'P');
    expect(mail.html).not.toContain('<script>');
  });
});

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
