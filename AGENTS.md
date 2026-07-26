# AGENTS.md

Vendor-neutral guide for AI coding agents (Codex, Cursor, Copilot, Gemini CLI, …).
Claude Code reads [`CLAUDE.md`](CLAUDE.md), which has the deep codebase map and
gotchas — **read that too**. This file is the short, portable version.

## What this is

ReachPilot — a LinkedIn + email outreach automation platform.
- **Frontend:** React 19 + Vite + Tailwind in `src/` (talks to `/api`, proxied to :4000).
- **Backend:** NestJS + Kysely/Postgres + Redis/BullMQ + Playwright in `server-v2/`.

## Run / build / verify

```bash
npm run web                              # frontend :5173
npm --prefix server-v2 run start:api     # API :4000
npm --prefix server-v2 run start:worker  # worker + scheduler
npx tsc --noEmit -p tsconfig.app.json    # typecheck frontend
npm --prefix server-v2 exec tsc --noEmit # typecheck backend
npm run lint                             # oxlint
```

Config lives in `server-v2/.env` (untracked). Copy `server-v2/.env.example`.

## Conventions (follow these)

- **Imports use the `@/` alias** → `src/*` (frontend) and `server-v2/src/*` (backend).
  Prefer `@/lib/api`, `@/types`, `@/components/ui` over relative paths.
- Frontend layout: `components/`, `hooks/`, `lib/api/`, `lib/utils/`, `constants/`,
  `types/`, `screens/`. Keep files single-purpose; a file exporting components
  should export only components (fast-refresh).
- Named constants over magic numbers; `import type { … }` for type-only imports
  (`verbatimModuleSyntax` is on).
- Baseline style rules live in `.agents/skills/coding-standards`.

## 🔴 Must-know gotchas (details in CLAUDE.md)

- **RLS everywhere.** Tenant tables use FORCE row-level security. Wrap DB access in
  `withWorkspace(workspaceId, db => …)` or reads return 0 rows / throw.
- **The scheduler is the backbone.** Scheduled jobs are drained by the scheduler
  tick, not inline — without the worker running, sequences never advance past day one.
- **Real LinkedIn safety.** Never repeat-login a real account. Use throwaway
  accounts + `LINKEDIN_DRIVER=simulator` for dev.
- **Secrets.** Never commit `.env`. `MASTER_KEY` encrypts stored credentials.

## Do not

- Do not hardcode secrets or paste real credentials into tracked files.
- Do not add DB migrations expecting the app DB user to have DDL rights.
- Do not point the app at a Supabase **transaction pooler** (:6543) — it breaks
  `SET LOCAL` used for RLS. Use session pooler / direct. See docs/adr/0001.
