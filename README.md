# ReachPilot

An Expandi-style **LinkedIn + email outreach automation** platform: import leads,
build multi-step sequences, and let a pacing engine send connection requests,
messages, InMails, and emails within safe, human-like daily limits — with real
LinkedIn browser automation and Gmail sending.

> ⚠️ Automating LinkedIn can conflict with its User Agreement and risks account
> restrictions. Use conservative limits, warm-up, and **throwaway accounts for
> testing**. See [Account safety](#account-safety).

## Features

- **Auto Connect / Auto Mail** — upload a list, send within a daily safe cap.
- **Campaigns & sequences** — multi-step drips with follow-ups and conditions.
- **Real drivers** — Playwright LinkedIn automation (login, connect, message,
  InMail, follow, visit, like, endorse) and Gmail API sending.
- **Pacing & safety engine** — warm-up ramp, daily/weekly caps, working hours,
  jitter, inter-action spacing, duplicate-invite guard, login cooldown.
- **Scheduler** — drains scheduled jobs so sequences advance past day one.
- **Inbox** — LinkedIn + email replies in one place; acceptance/reply sync.
- **Multi-tenant** — Postgres row-level security (RLS) per workspace.

## Tech stack

| Layer | Stack |
| --- | --- |
| Frontend | React 19 + Vite + Tailwind (`src/`), talks to `/api` (proxied to :4000) |
| Backend | NestJS + Kysely + Postgres + Redis (BullMQ) + Playwright (`server-v2/`) |
| Auth | Argon2 + JWT (access/refresh), per-workspace RLS |
| Secrets | Envelope encryption vault (`MASTER_KEY`) for LinkedIn creds/cookies/TOTP |

## Prerequisites

- Node.js 20+
- PostgreSQL 15+ (local, or a Supabase project — see [ADR-0001](docs/adr/0001-database-supabase-migration.md))
- Redis (local, or Upstash)
- For real LinkedIn automation: `npx playwright install chromium`

## Setup

```bash
# 1. Install deps
npm install
npm --prefix server-v2 install

# 2. Configure the backend
cp server-v2/.env.example server-v2/.env
#    then fill in DATABASE_URL, REDIS_URL, JWT secrets, MASTER_KEY, etc.

# 3. Apply the schema (fresh DB)
npm --prefix server-v2 run migrate
```

## Run

Three processes (each in its own terminal):

```bash
npm run web                              # frontend  -> http://localhost:5173
npm --prefix server-v2 run start:api     # API       -> http://localhost:4000
npm --prefix server-v2 run start:worker  # BullMQ worker + scheduler + Playwright
```

Open **http://localhost:5173**. With `AUTH_BYPASS=false` you get the real
signup/login flow; with `true` a default workspace is auto-provisioned.

## Project structure

```
src/                     # Frontend (Vite + React)
  components/            # UI components + Toast provider
  hooks/                 # reusable hooks
  lib/api/               # backend client ({ api, auth })
  lib/utils/             # cx, template helpers
  constants/, types/     # shared constants & domain types
  screens/               # page-level views
server-v2/               # Backend (NestJS)
  src/modules/           # auth, accounts, campaigns, engine, drivers, ...
  migrations/            # SQL migrations (0001 schema, 0003 RLS policies)
docs/adr/                # Architecture Decision Records
```

Imports use the `@/` alias → `src/` (frontend) and `server-v2/src/` (backend).

## Account safety

- **Never repeat-login a real LinkedIn account** — rapid automated logins trigger
  security challenges. Design: log in once → store the cookie → reuse it.
- Use **throwaway accounts** for testing. Warm-up + caps + working hours are the
  product, not an afterthought.
- Prefer a dedicated, country-matched proxy per account in production. Empty
  `PROXY_SERVER` egresses from the machine's local IP (OK for a single test).

## Documentation

- [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) — codebase map & conventions for AI agents.
- [`docs/adr/`](docs/adr/) — architecture decision records.
- `BACKEND_ARCHITECTURE.md`, `REACHPILOT_COMPLETE_SYSTEM_GUIDE.md` — deep design docs.

## Security

Never commit real `.env` files (they hold `MASTER_KEY`, DB password, OAuth
secrets). Only `.env.example` is tracked. Rotating `MASTER_KEY` makes existing
encrypted secrets unreadable.
