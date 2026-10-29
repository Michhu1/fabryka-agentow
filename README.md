# Fabryka Agentów (working name: moj-n8n)

**An open-source platform for building workflow automations and AI agents, made for small and medium businesses in Poland.**

- **n8n-compatible foundation.** Stage 1 rebuilds the behaviour of [n8n](https://n8n.io) feature by feature — with our own code,
  not a fork — using the same workflow format, so existing n8n workflows can be imported directly.
- **Polish-first.** Every screen, email and message is in Polish; the target users are small firms that English-first,
  enterprise-priced automation tools leave behind.
- **Built for many users from day one.** Strict per-project data isolation, roles (owner / editor / viewer), 2FA, API keys,
  invitations accepted by email — designed to run as a public multi-tenant cloud service.
- **Web and Windows desktop app.** The same Vue editor runs in the browser and in an Electron `.exe`; both connect to the same server.
- **Next:** workflows with drafts, publishing and version history → execution engine → visual canvas editor → AI agent builder.

| | |
|---|---|
| Status | Early stage. Done: M0 foundation (monorepo, Docker, desktop shell), M1 accounts and projects (sign-up, 2FA, password reset, team projects, invitations, project transfer, user admin, API keys) |
| Stack | TypeScript, Node 24, Express 5, PostgreSQL + TypeORM, Redis, Vue 3 + Pinia, Electron, Vitest, Playwright |
| Tests | unit + integration (real PostgreSQL) + end-to-end browser scenario with a real mailbox (Mailpit) |
| Licence | [AGPL-3.0](LICENSE) |

Not affiliated with n8n GmbH. "n8n" is used only to describe compatibility; no n8n source code is included.
Screenshots of the current screens: [`docs/zrzuty/m1/`](docs/zrzuty/m1/).

---

Dokumentacja dla deweloperów (po polsku) — poniżej.

## Wymagania
- Windows 10/11, Linux lub macOS
- **Docker Desktop** (włączony)
- **Node.js 24** (`.nvmrc`)
- pnpm przez Corepack: `corepack enable`

## Pierwsze uruchomienie
```bash
pnpm install
```

## Komendy
| Komenda | Co robi |
|---|---|
| `pnpm dev` | uruchamia wszystkie części w trybie deweloperskim |
| `pnpm build` | buduje wszystkie pakiety |
| `pnpm test` | testy jednostkowe |
| `pnpm test:int` | testy integracyjne (wymaga `pnpm infra:up`) |
| `pnpm test:e2e` | test całej aplikacji w przeglądarce (wymaga `pnpm infra:up`, opis niżej) |
| `pnpm verify` | lint + typy + testy (przed każdym commitem) |
| `pnpm infra:up` | uruchamia infrastrukturę w Dockerze (Postgres+pgvector, Redis, S3, Mailpit) |
| `pnpm infra:down` | zatrzymuje infrastrukturę (dane zostają w wolumenach) |
| `pnpm infra:logs` | logi infrastruktury |

## Infrastruktura lokalna
| Usługa | Adres | Uwagi |
|---|---|---|
| PostgreSQL 17 + pgvector | `localhost:5433` | user/hasło/baza: `moj_n8n` |
| Redis 7 | `localhost:6380` | potrzebny w trybie kolejki |
| S3 (SeaweedFS) | `http://localhost:9000` | klucze dev w `docker/s3.json`, bucket `moj-n8n` |
| Mailpit | `http://localhost:8025` | podgląd maili wysłanych przez aplikację |

### Bazy danych
Każde uruchomienie ma swoją bazę w tym samym PostgreSQL, żeby testy nigdy nie skasowały Twoich danych:

| Baza | Kto jej używa |
|---|---|
| `moj_n8n` | `pnpm dev` i Docker — Twoje konta i projekty |
| `moj_n8n_test` | `pnpm test:int` (czyszczona przed każdym testem) |
| `moj_n8n_e2e` | `pnpm test:e2e` (czyszczona przed każdym uruchomieniem) |

Bazy testowe powstają same przy pierwszym uruchomieniu testów.

## Konta i logowanie
- **Pierwsze konto = właściciel platformy.** Na czystej bazie otwórz `http://localhost:5681` (w dev) i kliknij
  „Załóż konto”. Pierwsza osoba, która się zarejestruje, zostaje właścicielem platformy (może zarządzać kontami
  w Ustawienia → Użytkownicy). Kolejne konta to zwykli użytkownicy.
- **Maile** (zaproszenia, reset hasła, przekazanie projektu) lokalnie nie wychodzą do internetu — trafiają do
  **Mailpit**: `http://localhost:8025`. Tam klikasz linki z wiadomości.
- Weryfikację dwuetapową (2FA) włączasz w Ustawienia → Osobiste; kod daje aplikacja w telefonie
  (np. Google Authenticator).

### Nowe zmienne środowiskowe (M1)
Wpisuje się je w `.env` (wzór: `.env.example`).

| Zmienna | Domyślnie | Co robi |
|---|---|---|
| `EDITOR_BASE_URL` | = `PUBLIC_URL` | adres, pod którym ludzie otwierają aplikację; z niego są linki w mailach. W dev `http://localhost:5681`. Adres `https://` włącza bezpieczne ciasteczko sesji i każe przeglądarce ładować wszystko przez https (przy `http://` tego nie robi, więc działa np. otwarcie po adresie IP w sieci lokalnej) |
| `SIGNUP_ENABLED` | `true` | czy każdy może sam założyć konto. `false` = tylko z zaproszenia (pierwsze konto zawsze można założyć) |
| `TEAM_PROJECTS_LIMIT` | `3` | ile projektów zespołowych może mieć jedna osoba jako właściciel |
| `PROXY_HOPS` | `0` | ile serwerów pośrednich (load balancer) stoi przed aplikacją w chmurze; lokalnie `0` |
| `SMTP_USER`, `SMTP_PASSWORD` | puste | login i hasło do serwera pocztowego w chmurze (Mailpit ich nie potrzebuje). Z loginem połączenie musi być szyfrowane |

## Test całej aplikacji (E2E)
`pnpm test:e2e` otwiera prawdziwą przeglądarkę (Chromium, bez okna) i przechodzi scenariusz jak człowiek:
rejestracja, projekt, zaproszenia, przekazanie projektu, reset hasła, 2FA, klucz API.

1. Na nowym komputerze raz: `pnpm exec playwright install chromium` (pobiera przeglądarkę).
2. Włącz infrastrukturę: `pnpm infra:up`.
3. Zatrzymaj `pnpm dev`, jeśli działa — test sam uruchamia serwer (port 5680) i edytor (port 5681)
   na osobnej bazie `moj_n8n_e2e` i czyści skrzynkę Mailpit.
4. `pnpm test:e2e`. Raport po nieudanym teście: `pnpm exec playwright show-report e2e/playwright-report`.

Zmienna `E2E_SCREENSHOTS=1` dodatkowo zapisuje zrzuty ekranów do `docs/zrzuty/m1/`
(PowerShell: `$env:E2E_SCREENSHOTS=1; pnpm test:e2e`). Gdy przeglądarka jest zainstalowana
gdzie indziej, wskaż ją zmienną `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Cała aplikacja w Dockerze (tak samo jak w chmurze)
```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml --profile app up -d --build
```
Aplikacja: `http://localhost:5680`. To ten sam obraz, który uruchomimy w chmurze — zmieniają się tylko zmienne w `.env`.

## Aplikacja .exe (Windows)
| Komenda | Co robi |
|---|---|
| `pnpm --filter @app/desktop dev` | otwiera okno aplikacji (łączy się z `http://localhost:5681` w trybie dev) |
| `pnpm --filter @app/desktop dist` | buduje instalator `packages/desktop/release/moj-n8n Setup <wersja>.exe` |

Adres serwera dla .exe można zmienić zmienną `APP_URL` (np. adres w chmurze).
