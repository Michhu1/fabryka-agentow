import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { EDITOR_URL, VIEWPORT } from './helpers/env';
import { latestLinkFor } from './helpers/mailpit';
import { totpCode } from './helpers/totp';

/**
 * M1 end to end: accounts, projects, invitations, project transfer, password reset and 2FA — the way two
 * people would do it in their own browsers (one browser context each). The steps build on each other,
 * so they run in order and stop at the first failure.
 *
 * `E2E_SCREENSHOTS=1 pnpm test:e2e` also saves screenshots of the main pages to `docs/zrzuty/m1/`.
 */

const OWNER = { firstName: 'Anna', lastName: 'Nowak', email: 'anna@test.pl', password: 'Start1234' };
const OWNER_NEW_PASSWORD = 'Nowe56789';
const JAN = { firstName: 'Jan', lastName: 'Kowalski', email: 'jan@test.pl', password: 'Jan12345' };
/** Has no account yet: invited only to the project "Biuro" (as Podgląd). */
const OLA = { firstName: 'Ola', lastName: 'Wiśniewska', email: 'ola@test.pl', password: 'Ola12345' };
const PROJECT = 'Biuro';

const SCREENSHOTS = process.env.E2E_SCREENSHOTS === '1';
const SCREENSHOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/zrzuty/m1');

/**
 * Saves a screenshot of the whole page when E2E_SCREENSHOTS=1. The app scrolls inside <main>, which is
 * as tall as the window, so the window is stretched to the content for the shot (not for dialogs, which
 * look best centered in a normal window).
 */
async function screenshot(page: Page, name: string, { stretch = true } = {}): Promise<void> {
  if (!SCREENSHOTS) return;
  // Let fonts, fades and dialogs settle.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const height = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return 0;
    return main.scrollHeight + (window.innerHeight - main.clientHeight);
  });
  const resized = stretch && height > VIEWPORT.height;
  if (resized) {
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.ceil(height) });
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
  if (resized) await page.setViewportSize(VIEWPORT);
}

async function newPerson(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: EDITOR_URL,
    viewport: VIEWPORT,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    acceptDownloads: true,
  });
  return { context, page: await context.newPage() };
}

/** The `<input>` of an AppInput marked with `data-test` (the attribute sits on its wrapper). */
function field(page: Page, dataTest: string) {
  return page.locator(`[data-test="${dataTest}"] input`);
}

async function logout(page: Page): Promise<void> {
  await page.goto('/home');
  await page.locator('[data-test="user-menu"]').click();
  await page.getByRole('menuitem', { name: 'Wyloguj się' }).click();
  await expect(page).toHaveURL(/\/signin/);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/signin');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Hasło', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
}

test.describe
  .serial('M1: konta i projekty', () => {
    let owner: { context: BrowserContext; page: Page };
    let jan: { context: BrowserContext; page: Page };
    let projectId = '';
    let mfaSecret = '';

    test.beforeAll(async ({ browser }) => {
      owner = await newPerson(browser);
      jan = await newPerson(browser);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures from this pattern; none needed
    test.afterEach(async ({}, testInfo) => {
      if (testInfo.status === testInfo.expectedStatus) return;
      for (const [who, person] of [
        ['wlasciciel', owner],
        ['jan', jan],
      ] as const) {
        if (!person || person.page.isClosed()) continue;
        await testInfo.attach(`${who}.png`, {
          body: await person.page.screenshot(),
          contentType: 'image/png',
        });
      }
    });

    test.afterAll(async () => {
      await owner?.context.close();
      await jan?.context.close();
    });

    test('pierwsze konto zakłada właściciel platformy', async () => {
      const { page } = owner;
      await page.goto('/');
      await expect(page).toHaveURL(/\/signin/);
      await expect(page.getByRole('heading', { name: 'Zaloguj się' })).toBeVisible();
      await screenshot(page, '01-logowanie');

      await page.getByRole('link', { name: 'Załóż konto' }).click();
      await expect(page).toHaveURL(/\/signup/);
      await page.getByLabel('Imię').fill(OWNER.firstName);
      await page.getByLabel('Nazwisko').fill(OWNER.lastName);
      await page.getByLabel('E-mail').fill(OWNER.email);
      await page.getByLabel('Hasło', { exact: true }).fill(OWNER.password);
      await page.getByRole('button', { name: 'Załóż konto' }).click();

      await expect(page).toHaveURL(/\/home$/);
      await expect(page.getByRole('heading', { name: `Witaj, ${OWNER.firstName}!` })).toBeVisible();
      const menu = page.getByRole('navigation', { name: 'Menu główne' });
      await expect(menu.getByRole('link', { name: 'Przegląd' })).toBeVisible();
      await expect(menu.getByRole('link', { name: 'Osobiste' })).toBeVisible();
      await expect(page.locator('[data-test="projects-counter"]')).toHaveText('Projekty: 0 z 3');
    });

    test('właściciel tworzy projekt „Biuro”', async () => {
      const { page } = owner;
      await page.locator('[data-test="overview-new-project"]').click();
      const dialog = page.getByRole('dialog', { name: 'Nowy projekt' });
      await dialog.getByLabel('Nazwa projektu').fill(PROJECT);
      await dialog.getByRole('button', { name: 'Utwórz projekt' }).click();

      await expect(page).toHaveURL(/\/projects\/[^/]+$/);
      projectId = new URL(page.url()).pathname.split('/').pop() ?? '';
      await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible();
      await expect(page.getByText('Twoja rola: Właściciel')).toBeVisible();
      await expect(page.locator('[data-test="projects-counter"]')).toHaveText('Projekty: 1 z 3');

      await page
        .getByRole('navigation', { name: 'Menu główne' })
        .getByRole('link', { name: 'Przegląd' })
        .click();
      await expect(page.locator('[data-test="project-card"]', { hasText: PROJECT })).toBeVisible();
      await screenshot(page, '02-przeglad');
    });

    test('właściciel zaprasza Jana na platformę, Jan zakłada konto z linku', async () => {
      const { page } = owner;
      await page.goto('/settings/users');
      await page.locator('[data-test="users-invite"]').click();
      await page.locator('[data-test="invite-emails"] textarea').fill(JAN.email);
      await page.locator('[data-test="invite-submit"]').click();
      await expect(page.locator('[data-test="invite-results"]')).toContainText(JAN.email);
      await expect(page.locator('[data-test="invite-results"]')).toContainText('Zaproszenie wysłane');
      await page.locator('[data-test="invite-done"]').click();
      await expect(page.locator('[data-test="user-row"]', { hasText: JAN.email })).toContainText(
        'Zaproszony',
      );

      const link = await latestLinkFor(JAN.email, '/accept-invite');
      await jan.page.goto(link);
      await expect(jan.page.getByRole('heading', { name: 'Dołącz do platformy' })).toBeVisible();
      await jan.page.getByLabel('Imię').fill(JAN.firstName);
      await jan.page.getByLabel('Nazwisko').fill(JAN.lastName);
      await jan.page.getByLabel('Hasło', { exact: true }).fill(JAN.password);
      await jan.page.getByRole('button', { name: 'Utwórz konto' }).click();
      await expect(jan.page).toHaveURL(/\/home$/);
      await expect(jan.page.getByRole('heading', { name: `Witaj, ${JAN.firstName}!` })).toBeVisible();

      await page.reload();
      const row = page.locator('[data-test="user-row"]', { hasText: JAN.email });
      await expect(row).toContainText(`${JAN.firstName} ${JAN.lastName}`);
      await expect(row).toContainText('Aktywny');
      await screenshot(page, '05-uzytkownicy');
    });

    test('właściciel zaprasza Jana do projektu jako Edytora, Jan akceptuje', async () => {
      const { page } = owner;
      await page.goto(`/projects/${projectId}/settings`);
      await field(page, 'invite-email').fill(JAN.email);
      await page.locator('[data-test="invite-role"] select').selectOption({ label: 'Edytor' });
      await page.getByRole('button', { name: 'Wyślij zaproszenie' }).click();
      await expect(page.getByText(`Zaproszenie wysłane na adres ${JAN.email}.`)).toBeVisible();
      await expect(page.locator('[data-test="invite-section"]')).toContainText(JAN.email);

      const link = await latestLinkFor(JAN.email, '/project-invitation');
      await jan.page.goto(link);
      await expect(jan.page.getByRole('heading', { name: 'Zaproszenie do projektu' })).toBeVisible();
      await expect(jan.page.getByText(`zaprasza Cię do projektu „${PROJECT}”`)).toBeVisible();
      await expect(jan.page.getByText('Twoja rola: Edytor')).toBeVisible();
      await jan.page.getByRole('button', { name: 'Akceptuj' }).click();

      await expect(jan.page).toHaveURL(new RegExp(`/projects/${projectId}$`));
      await expect(jan.page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible();
      await expect(jan.page.getByText('Twoja rola: Edytor')).toBeVisible();
      await expect(
        jan.page.getByRole('navigation', { name: 'Menu główne' }).getByRole('link', { name: PROJECT }),
      ).toBeVisible();
    });

    test('właściciel przekazuje projekt Janowi (potwierdza hasłem)', async () => {
      const { page } = owner;
      await page.reload();
      await expect(page.locator('[data-test="member-row"]', { hasText: JAN.email })).toBeVisible();
      // A second, still pending invitation (to someone without an account) for the screenshot.
      await field(page, 'invite-email').fill(OLA.email);
      await page.locator('[data-test="invite-role"] select').selectOption({ label: 'Podgląd' });
      await page.getByRole('button', { name: 'Wyślij zaproszenie' }).click();
      await expect(page.getByText(`Zaproszenie wysłane na adres ${OLA.email}.`)).toBeVisible();

      await page.locator('[data-test="transfer"]').click();
      const dialog = page.getByRole('dialog', { name: `Przekaż projekt „${PROJECT}”` });
      await field(page, 'transfer-email').fill(JAN.email);
      await field(page, 'transfer-password').fill(OWNER.password);
      await dialog.getByRole('button', { name: 'Wyślij prośbę o przekazanie' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('[data-test="transfer-pending"]')).toContainText(JAN.email);
      // Nothing changes before Jan accepts.
      await expect(page.getByText('Twoja rola: Właściciel')).toBeVisible();
      await screenshot(page, '03-ustawienia-projektu');
    });

    test('Jan akceptuje przekazanie — jest właścicielem, Anna zostaje Edytorem', async () => {
      const link = await latestLinkFor(JAN.email, '/project-transfer');
      await jan.page.goto(link);
      await expect(jan.page.getByRole('heading', { name: 'Przekazanie projektu' })).toBeVisible();
      await expect(jan.page.getByText(`chce przekazać Ci projekt „${PROJECT}”`)).toBeVisible();
      await jan.page.getByRole('button', { name: 'Akceptuj' }).click();

      await expect(jan.page).toHaveURL(new RegExp(`/projects/${projectId}$`));
      await expect(jan.page.getByText('Twoja rola: Właściciel')).toBeVisible();
      await expect(jan.page.locator('[data-test="projects-counter"]')).toHaveText('Projekty: 1 z 3');

      await jan.page.locator('[data-test="project-settings-link"]').click();
      const annaRow = jan.page.locator('[data-test="member-row"]', { hasText: OWNER.email });
      await expect(annaRow.locator('select')).toHaveValue('project:editor');
      const janRow = jan.page.locator('[data-test="member-row"]', { hasText: JAN.email });
      await expect(janRow).toContainText('Właściciel');

      const { page } = owner;
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByText('Twoja rola: Edytor')).toBeVisible();
      await expect(page.locator('[data-test="projects-counter"]')).toHaveText('Projekty: 0 z 3');
      await page.goto(`/projects/${projectId}/settings`);
      await expect(page.locator('[data-test="transfer-section"]')).toHaveCount(0);
      await expect(page.locator('[data-test="leave-section"]')).toBeVisible();
    });

    test('Anna resetuje zapomniane hasło i loguje się nowym', async () => {
      const { page } = owner;
      await logout(page);
      await page.getByRole('link', { name: 'Nie pamiętasz hasła?' }).click();
      await expect(page).toHaveURL(/\/forgot-password/);
      await page.getByLabel('E-mail').fill(OWNER.email);
      await page.getByRole('button', { name: 'Wyślij link' }).click();
      await expect(page.getByText(`Jeśli konto z adresem ${OWNER.email} istnieje`)).toBeVisible();

      const link = await latestLinkFor(OWNER.email, '/reset-password');
      await page.goto(link);
      await expect(page.getByRole('heading', { name: 'Ustaw nowe hasło' })).toBeVisible();
      await page.getByLabel('Nowe hasło', { exact: true }).fill(OWNER_NEW_PASSWORD);
      await page.getByLabel('Powtórz nowe hasło').fill(OWNER_NEW_PASSWORD);
      await page.getByRole('button', { name: 'Zapisz nowe hasło' }).click();
      // Setting the new password also signs in.
      await expect(page).toHaveURL(/\/home$/);

      await logout(page);
      await signIn(page, OWNER.email, OWNER.password);
      await expect(page.getByText('Nieprawidłowy e-mail lub hasło.')).toBeVisible();
      await signIn(page, OWNER.email, OWNER_NEW_PASSWORD);
      await expect(page).toHaveURL(/\/home$/);
      await expect(page.getByRole('heading', { name: `Witaj, ${OWNER.firstName}!` })).toBeVisible();
    });

    test('Anna włącza weryfikację dwuetapową', async () => {
      const { page } = owner;
      await page.locator('[data-test="user-menu"]').click();
      await page.getByRole('menuitem', { name: 'Ustawienia' }).click();
      await expect(page).toHaveURL(/\/settings\/personal$/);
      await expect(page.locator('[data-test="mfa-status"]')).toContainText('Wyłączona');
      await screenshot(page, '04-osobiste');

      await page.locator('[data-test="mfa-enable-open"]').click();
      const dialog = page.getByRole('dialog', { name: 'Włącz weryfikację dwuetapową' });
      const secret = dialog.locator('[data-test="mfa-secret"]');
      await expect(secret).toHaveText(/^[A-Z2-7]{16,}$/);
      mfaSecret = (await secret.textContent())?.trim() ?? '';
      await screenshot(page, '06-2fa', { stretch: false });
      await dialog.locator('[data-test="mfa-next"]').click();

      const codes = (await dialog.locator('[data-test="mfa-codes"] li').allTextContents()).map((code) =>
        code.trim(),
      );
      expect(codes).toHaveLength(10);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog.locator('[data-test="mfa-download"]').click(),
      ]);
      expect(download.suggestedFilename()).toBe('moj-n8n-kody-odzyskiwania.txt');
      const file = await readFile(await download.path(), 'utf8');
      for (const code of codes) expect(file).toContain(code);

      await dialog.locator('[data-test="mfa-next"]').click();
      await field(page, 'mfa-code').fill(await totpCode(mfaSecret));
      await dialog.locator('[data-test="mfa-enable"]').click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('[data-test="mfa-status"]')).toContainText('Włączona');
    });

    test('logowanie wymaga teraz kodu z aplikacji', async () => {
      const { page } = owner;
      await logout(page);
      await signIn(page, OWNER.email, OWNER_NEW_PASSWORD);
      await expect(page.getByRole('heading', { name: 'Weryfikacja dwuetapowa' })).toBeVisible();
      await expect(page).toHaveURL(/\/signin/);

      await page.getByLabel('Kod z aplikacji').fill(await totpCode(mfaSecret));
      await page.getByRole('button', { name: 'Zweryfikuj' }).click();
      await expect(page).toHaveURL(/\/home$/);
      await expect(page.getByRole('heading', { name: `Witaj, ${OWNER.firstName}!` })).toBeVisible();
    });

    test('klucze API: Anna tworzy klucz, lista pokazuje go bez pełnej wartości', async () => {
      const { page } = owner;
      await page.goto('/settings/api');
      await page.locator('[data-test="api-key-create"]').click();
      await field(page, 'api-key-label').fill('Integracja z CRM');
      await page.locator('[data-test="api-key-submit"]').click();
      const raw = await page.locator('[data-test="api-key-raw"]').inputValue();
      expect(raw.length).toBeGreaterThan(20);
      await page.locator('[data-test="api-key-done"]').click();
      const row = page.locator('[data-test="api-key-row"]', { hasText: 'Integracja z CRM' });
      await expect(row).toBeVisible();
      await expect(row).not.toContainText(raw);
      await screenshot(page, '07-klucze-api');

      // The key works on the public API; the session cookie alone (sent by page.request) does not.
      const withKey = await page.request.get('/api/v1/projects', { headers: { 'X-API-KEY': raw } });
      expect(withKey.status()).toBe(200);
      const { data } = (await withKey.json()) as { data: { name: string; type: string; role: string }[] };
      expect(
        data
          .map(({ name, type, role }) => ({ name, type, role }))
          .sort((a, b) => a.type.localeCompare(b.type)),
      ).toEqual([
        {
          name: `${OWNER.firstName} ${OWNER.lastName} <${OWNER.email}>`,
          type: 'personal',
          role: 'project:personalOwner',
        },
        { name: PROJECT, type: 'team', role: 'project:editor' },
      ]);
      const withoutKey = await page.request.get('/api/v1/projects');
      expect(withoutKey.status()).toBe(401);
      const wrongKey = await page.request.get('/api/v1/projects', { headers: { 'X-API-KEY': `${raw}x` } });
      expect(wrongKey.status()).toBe(401);
    });

    test('Ola (bez konta) otwiera link do projektu, zakłada konto i akceptuje jako Podgląd', async ({
      browser,
    }) => {
      // Invited to "Biuro" by Anna before the transfer: the invitation outlives the change of owner.
      const ola = await newPerson(browser);
      try {
        const { page } = ola;
        const link = await latestLinkFor(OLA.email, '/project-invitation');
        await page.goto(link);
        await expect(page.getByRole('heading', { name: 'Zaproszenie do projektu' })).toBeVisible();
        await expect(page.getByText(`zaprasza Cię do projektu „${PROJECT}”`)).toBeVisible();
        await expect(page.getByText('Twoja rola: Podgląd')).toBeVisible();
        await expect(page.getByText(`Link jest dla adresu ${OLA.email}.`)).toBeVisible();
        await page.locator('[data-test="account-link"]').click();

        await expect(page).toHaveURL(/\/signup\?/);
        const email = page.getByLabel('E-mail');
        await expect(email).toHaveValue(OLA.email);
        await expect(email).toHaveAttribute('readonly', '');
        await page.getByLabel('Imię').fill(OLA.firstName);
        await page.getByLabel('Nazwisko').fill(OLA.lastName);
        await page.getByLabel('Hasło', { exact: true }).fill(OLA.password);
        await page.getByRole('button', { name: 'Załóż konto' }).click();

        // Back on the link page, now signed in with the invited address.
        await expect(page).toHaveURL(/\/project-invitation\?token=/);
        await page.getByRole('button', { name: 'Akceptuj' }).click();
        await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
        await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible();
        await expect(page.getByText('Twoja rola: Podgląd')).toBeVisible();
        await expect(
          page.getByRole('navigation', { name: 'Menu główne' }).getByRole('link', { name: PROJECT }),
        ).toBeVisible();
      } finally {
        await ola.context.close();
      }
    });
  });
