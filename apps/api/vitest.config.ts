import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, env: { DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://dosly:dosly@localhost:5432/dosly_test' } } });
