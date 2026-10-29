import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

/** Raw environment variables, validated. Keys mirror n8n naming where n8n has an equivalent. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: port(5680),
  PUBLIC_URL: z.url().optional(),
  WEBHOOK_URL: z.url().optional(),
  EXECUTIONS_MODE: z.enum(['regular', 'queue']).default('regular'),
  PUBLIC_MODE: bool(true),
  ENCRYPTION_KEY: z.string().min(32),
  EDITOR_DIST_PATH: z.string().min(1).optional(),
  METRICS_ENABLED: bool(false),

  /** Where users open the editor; used for links in emails and the Secure cookie flag. */
  EDITOR_BASE_URL: z.url().optional(),
  SIGNUP_ENABLED: bool(true),
  TEAM_PROJECTS_LIMIT: z.coerce.number().int().min(0).default(3),
  /** Reverse proxies in front of the app whose X-Forwarded-For is trusted (n8n: N8N_PROXY_HOPS). */
  PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  DB_POSTGRESDB_HOST: z.string().min(1).default('localhost'),
  DB_POSTGRESDB_PORT: port(5433),
  DB_POSTGRESDB_DATABASE: z.string().min(1).default('moj_n8n'),
  DB_POSTGRESDB_USER: z.string().min(1).default('moj_n8n'),
  DB_POSTGRESDB_PASSWORD: z.string().default('moj_n8n'),
  DB_POSTGRESDB_SSL: bool(false),
  DB_POSTGRESDB_SSL_CA: z.string().min(1).optional(),

  REDIS_URL: z.string().min(1).default('redis://localhost:6380'),

  S3_ENDPOINT: z.url().default('http://localhost:9000'),
  S3_BUCKET: z.string().min(1).default('moj-n8n'),
  S3_ACCESS_KEY: z.string().min(1).default('devaccesskey'),
  S3_SECRET_KEY: z.string().min(1).default('devsecretkey'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_FORCE_PATH_STYLE: bool(true),

  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: port(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().min(1).default('moj-n8n <no-reply@localhost>'),
});
