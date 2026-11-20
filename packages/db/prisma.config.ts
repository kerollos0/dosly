import { defineConfig } from 'prisma/config';

// `prisma generate` runs at build time without a database, so the URL is only required by migrate commands.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://build:build@localhost:5432/build' }
});
