import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().min(32),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  UPLOAD_DIR: z.string().default('./uploads'),
  ALLOW_SIGNUP: z.enum(['true', 'false']).default('true'),
  // Demo mode: no Meta calls at all. Visitors get a private sandbox agency with simulated customers.
  DEMO_MODE: z.enum(['true', 'false']).default('false')
}).refine(e => e.DEMO_MODE === 'true' || (e.META_APP_SECRET.length > 0 && e.META_VERIFY_TOKEN.length >= 8), {
  message: 'META_APP_SECRET and META_VERIFY_TOKEN (8+ chars) are required unless DEMO_MODE=true'
});

export type Env = z.infer<typeof schema>;
export const loadEnv = (src = process.env): Env => schema.parse(src);
