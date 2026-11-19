import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().min(32),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(8),
  UPLOAD_DIR: z.string().default('./uploads'),
  ALLOW_SIGNUP: z.enum(['true', 'false']).default('true')
});

export type Env = z.infer<typeof schema>;
export const loadEnv = (src = process.env): Env => schema.parse(src);
