# Dosly (دوسلي)

Arabic-first dashboard for marketing agencies: every client's WhatsApp inbox, scheduled Facebook and Instagram posts, and the team, in one place.

## Structure

| Path | What |
| --- | --- |
| `apps/web` | Next.js app (RTL Arabic UI) |
| `apps/api` | Fastify API, Meta webhooks, Socket.IO |
| `apps/worker` | BullMQ workers: webhook processing, scheduled publishing, overdue sweep |
| `packages/db` | Prisma schema and migrations (PostgreSQL) |
| `packages/core` | Business logic shared by API and worker |
| `packages/shared` | Crypto, roles, Meta Graph API client, validation schemas |

Architecture decisions: `docs/ARCHITECTURE.md`. Deploying to a VPS: `docs/DEPLOY.md` (Arabic).

## Local development

Requires Node 22, pnpm 10, PostgreSQL 16 and Redis 7.

```sh
pnpm install
cp .env.example .env            # fill DATABASE_URL, ENCRYPTION_KEY, META_* for local use
pnpm --filter @dosly/shared build && pnpm --filter @dosly/db build && pnpm --filter @dosly/core build
pnpm db:deploy
pnpm --filter @dosly/api dev    # http://localhost:4000
pnpm --filter @dosly/worker dev
pnpm --filter @dosly/web dev    # http://localhost:3000 (proxies /api to :4000)
```

Tests need a database: `DATABASE_URL=postgresql://.../dosly_test pnpm test`.

## Rules

- Every tenant-owned row has `agencyId`; every query filters by it.
- Meta tokens are stored AES-256-GCM encrypted and never returned by the API.
- Webhooks are verified (`X-Hub-Signature-256`), stored, and processed by the worker. Handlers are idempotent.
- Never commit `.env`, tokens or passwords.
