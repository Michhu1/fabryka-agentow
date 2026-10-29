import path from 'node:path';
import { envSchema } from './schema.js';

export type AppConfig = {
  env: 'development' | 'production' | 'test';
  port: number;
  publicUrl: string;
  webhookUrl: string;
  executionsMode: 'regular' | 'queue';
  /** When true, nodes that touch the host (disk, shell, SSH to localhost) are disabled. */
  publicMode: boolean;
  encryptionKey: string;
  editorDistPath?: string;
  /** Exposes Prometheus /metrics (off by default, like n8n's N8N_METRICS). */
  metricsEnabled: boolean;
  /** Base URL of the editor without a trailing slash (email links; `https://` turns on Secure cookies). */
  editorBaseUrl: string;
  /** Public self-signup; when false only the very first account (the owner) can sign up. */
  signupEnabled: boolean;
  /** Max team projects a user can be admin of (product decision; n8n Trial allows 1). */
  teamProjectsLimit: number;
  /** Number of trusted reverse proxies (load balancer, ingress); 0 = use the socket address. */
  proxyHops: number;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
    /** PEM CA for managed Postgres with a private CA (n8n: DB_POSTGRESDB_SSL_CA). */
    sslCa?: string;
  };
  redis: { url: string };
  s3: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    region: string;
    forcePathStyle: boolean;
  };
  smtp: { host: string; port: number; user?: string; password?: string; from: string };
};

/** Thrown when environment variables are missing or invalid. Never includes the offending values. */
export class ConfigError extends Error {
  constructor(readonly invalidKeys: string[]) {
    super(`Invalid or missing environment variables: ${invalidKeys.join(', ')}`);
    this.name = 'ConfigError';
  }
}

/** Development values published in this repo (.env.example, docker/s3.json) — never valid in production. */
const PUBLISHED_DEV_SECRETS: Record<string, string> = {
  ENCRYPTION_KEY: 'dev-only-change-me-dev-only-change-me',
  DB_POSTGRESDB_PASSWORD: 'moj_n8n',
  S3_ACCESS_KEY: 'devaccesskey',
  S3_SECRET_KEY: 'devsecretkey',
};

/** In production every secret must be set explicitly and must not be a published dev value. */
function insecureProductionKeys(env: Record<string, string | undefined>): string[] {
  return Object.entries(PUBLISHED_DEV_SECRETS)
    .filter(([key, devValue]) => !env[key] || env[key] === devValue)
    .map(([key]) => key)
    .sort();
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const keys = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    throw new ConfigError([...keys].sort());
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    const insecure = insecureProductionKeys(env);
    if (insecure.length > 0) throw new ConfigError(insecure);
  }
  const publicUrl = e.PUBLIC_URL ?? `http://localhost:${e.PORT}`;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    publicUrl,
    webhookUrl: e.WEBHOOK_URL ?? publicUrl,
    executionsMode: e.EXECUTIONS_MODE,
    publicMode: e.PUBLIC_MODE,
    encryptionKey: e.ENCRYPTION_KEY,
    editorDistPath: e.EDITOR_DIST_PATH ? path.resolve(e.EDITOR_DIST_PATH) : undefined,
    metricsEnabled: e.METRICS_ENABLED,
    editorBaseUrl: (e.EDITOR_BASE_URL ?? publicUrl).replace(/\/+$/, ''),
    signupEnabled: e.SIGNUP_ENABLED,
    teamProjectsLimit: e.TEAM_PROJECTS_LIMIT,
    proxyHops: e.PROXY_HOPS,
    db: {
      host: e.DB_POSTGRESDB_HOST,
      port: e.DB_POSTGRESDB_PORT,
      database: e.DB_POSTGRESDB_DATABASE,
      user: e.DB_POSTGRESDB_USER,
      password: e.DB_POSTGRESDB_PASSWORD,
      ssl: e.DB_POSTGRESDB_SSL,
      sslCa: e.DB_POSTGRESDB_SSL_CA,
    },
    redis: { url: e.REDIS_URL },
    s3: {
      endpoint: e.S3_ENDPOINT,
      bucket: e.S3_BUCKET,
      accessKey: e.S3_ACCESS_KEY,
      secretKey: e.S3_SECRET_KEY,
      region: e.S3_REGION,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    },
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      password: e.SMTP_PASSWORD,
      from: e.SMTP_FROM,
    },
  };
}
