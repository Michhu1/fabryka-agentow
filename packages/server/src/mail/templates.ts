import { APP_NAME } from '@app/shared';

export type EmailContent = { subject: string; text: string; html: string };

/** Escapes a value for HTML text and quoted attributes. Every interpolated value goes through it. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Minimal, client-safe layout: inline styles only, one call-to-action button plus the raw link. */
function layout(paragraphs: string[], button: { label: string; link: string }, footer: string): string {
  const link = escapeHtml(button.link);
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('\n');
  return `<!doctype html>
<html lang="pl">
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2328">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
<p style="margin:0 0 24px;font-weight:bold;font-size:18px">${escapeHtml(APP_NAME)}</p>
${body}
<p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#ff6d5a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">${escapeHtml(button.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#57606a">Jeśli przycisk nie działa, skopiuj ten adres do przeglądarki:<br><a href="${link}" style="color:#57606a;word-break:break-all">${link}</a></p>
<p style="margin:0;font-size:13px;color:#57606a">${footer}</p>
</div>
</body>
</html>`;
}

/** Password reset link, valid for 20 minutes (see password-reset.ts). */
export function passwordResetEmail(link: string): EmailContent {
  const footer =
    'Jeśli ta prośba nie pochodzi od Ciebie, zignoruj tę wiadomość — Twoje hasło się nie zmieni.';
  return {
    subject: `Ustaw nowe hasło do ${APP_NAME}`,
    text: [
      'Cześć!',
      '',
      `Ktoś (mamy nadzieję, że Ty) poprosił o ustawienie nowego hasła do konta w ${APP_NAME}.`,
      'Aby ustawić nowe hasło, otwórz ten link (jest ważny przez 20 minut):',
      '',
      link,
      '',
      footer,
    ].join('\n'),
    html: layout(
      [
        'Cześć!',
        `Ktoś (mamy nadzieję, że Ty) poprosił o ustawienie nowego hasła do konta w ${escapeHtml(APP_NAME)}.`,
        'Kliknij przycisk poniżej, aby ustawić nowe hasło. Link jest ważny przez <strong>20 minut</strong>.',
      ],
      { label: 'Ustaw nowe hasło', link },
      footer,
    ),
  };
}

/**
 * Invitation to join the instance, valid for 7 days (see invitations.ts). `inviterName` is user input:
 * it is escaped in HTML and kept out of the subject header.
 */
export function invitationEmail(link: string, inviterName: string): EmailContent {
  const footer = 'Jeśli nie spodziewasz się tego zaproszenia, po prostu zignoruj tę wiadomość.';
  return {
    subject: `Zaproszenie do ${APP_NAME}`,
    text: [
      'Cześć!',
      '',
      `${inviterName} zaprasza Cię do ${APP_NAME} — miejsca, w którym budujesz automatyzacje i agentów AI.`,
      'Aby przyjąć zaproszenie i założyć konto, otwórz ten link (jest ważny przez 7 dni):',
      '',
      link,
      '',
      footer,
    ].join('\n'),
    html: layout(
      [
        'Cześć!',
        `<strong>${escapeHtml(inviterName)}</strong> zaprasza Cię do ${escapeHtml(APP_NAME)} — miejsca, w którym budujesz automatyzacje i agentów AI.`,
        'Kliknij przycisk poniżej, aby przyjąć zaproszenie i założyć konto. Link jest ważny przez <strong>7 dni</strong>.',
      ],
      { label: 'Przyjmij zaproszenie', link },
      footer,
    ),
  };
}

/**
 * Invitation to a team project, valid for 7 days (see project-invitations.ts). The text is the same
 * whether or not the address has an account (the link's page offers signing in or signing up).
 * `inviterName` and `projectName` are user input: escaped in HTML and kept out of the subject header.
 */
export function projectInvitationEmail(link: string, inviterName: string, projectName: string): EmailContent {
  const footer = 'Jeśli nie spodziewasz się tego zaproszenia, po prostu zignoruj tę wiadomość.';
  return {
    subject: `Zaproszenie do projektu w ${APP_NAME}`,
    text: [
      'Cześć!',
      '',
      `${inviterName} zaprasza Cię do projektu „${projectName}” w ${APP_NAME}.`,
      'Aby zaakceptować zaproszenie, otwórz ten link i kliknij „Akceptuj” (link jest ważny przez 7 dni i działa tylko raz).',
      'Jeśli nie masz jeszcze konta, założysz je na ten adres e-mail.',
      '',
      link,
      '',
      footer,
    ].join('\n'),
    html: layout(
      [
        'Cześć!',
        `<strong>${escapeHtml(inviterName)}</strong> zaprasza Cię do projektu <strong>„${escapeHtml(projectName)}”</strong> w ${escapeHtml(APP_NAME)}.`,
        'Kliknij przycisk poniżej, aby zaakceptować zaproszenie. Jeśli nie masz jeszcze konta, założysz je na ten adres e-mail. Link jest ważny przez <strong>7 dni</strong> i działa tylko raz.',
      ],
      { label: 'Akceptuj zaproszenie', link },
      footer,
    ),
  };
}

/**
 * Request to take over a team project, valid for 7 days (see project-transfers.ts). Same text whether
 * or not the address has an account; `fromName` and `projectName` are user input (escaped in HTML,
 * kept out of the subject header).
 */
export function projectTransferEmail(link: string, fromName: string, projectName: string): EmailContent {
  const footer =
    'Jeśli nie spodziewasz się tej wiadomości, po prostu ją zignoruj — bez Twojej akceptacji nic się nie zmieni.';
  return {
    subject: `Przekazanie projektu w ${APP_NAME}`,
    text: [
      'Cześć!',
      '',
      `${fromName} chce przekazać Ci projekt „${projectName}” w ${APP_NAME}.`,
      `Po akceptacji zostaniesz jego właścicielem, a ${fromName} zostanie edytorem.`,
      'Aby przejąć projekt, otwórz ten link i kliknij „Akceptuj” (link jest ważny przez 7 dni i działa tylko raz).',
      'Jeśli nie masz jeszcze konta, założysz je na ten adres e-mail.',
      '',
      link,
      '',
      footer,
    ].join('\n'),
    html: layout(
      [
        'Cześć!',
        `<strong>${escapeHtml(fromName)}</strong> chce przekazać Ci projekt <strong>„${escapeHtml(projectName)}”</strong> w ${escapeHtml(APP_NAME)}.`,
        `Po akceptacji zostaniesz jego właścicielem, a ${escapeHtml(fromName)} zostanie edytorem.`,
        'Kliknij przycisk poniżej, aby przejąć projekt. Jeśli nie masz jeszcze konta, założysz je na ten adres e-mail. Link jest ważny przez <strong>7 dni</strong> i działa tylko raz.',
      ],
      { label: 'Akceptuj przekazanie', link },
      footer,
    ),
  };
}
