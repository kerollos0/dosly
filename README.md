# Dosly (دوسلي)

Arabic-first dashboard for marketing agencies: every client's WhatsApp inbox, scheduled Facebook and Instagram posts, and the team, in one place.

It has four surfaces on one API and database, each with its own sign-in:

| Surface | Path | Who | Sign-in |
| --- | --- | --- | --- |
| Agency dashboard | `/inbox`, `/calendar`, … | The agency team (owner, manager, moderator, writer) | Email + password, `dosly_session` |
| Client portal | `/portal` | The agency's client (business owner): approve posts, monthly report | One-time link, `dosly_portal` |
| Dosly admin | `/admin` | Dosly staff: agencies, plans, payments, suspension, support sign-in, health | Password + authenticator code, `dosly_admin` |
| Demo | `/login` → "try the demo" | Anyone, when `DEMO_MODE=true` | One click, a private sandbox per visitor |

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

### Demo mode

Set `DEMO_MODE=true` (API and worker). Meta is fully simulated, the `META_*` values can stay empty, and the
login page offers "try the demo": each visitor gets a private agency with four clients, a month of
conversations and posts, fake customers who write and answer, the client portal and a read-only tour of
the admin. Sandboxes are deleted after 24 hours. Never enable it on an instance with real agencies.

### Admin accounts

Created on the server only, with the password typed at a prompt (never on the command line):

```sh
pnpm --filter @dosly/api build && pnpm --filter @dosly/api admin:create you@example.com "Your Name"
```

It prints an authenticator key once. Sign in at `/admin/login`.

## Rules

- Every tenant-owned row has `agencyId`; every query filters by it.
- Meta tokens are stored AES-256-GCM encrypted and never returned by the API.
- Webhooks are verified (`X-Hub-Signature-256`), stored, and processed by the worker. Handlers are idempotent.
- Never commit `.env`, tokens or passwords.
- Agency, portal and admin sessions are separate tables and cookies; a session of one kind never opens another's routes.
- Suspended agencies, expired trials or subscriptions, and support sign-ins are read-only at the API level.
