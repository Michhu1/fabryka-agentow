import path from 'node:path';
import type { AppConfig } from '@app/config';
import { APP_NAME, APP_VERSION, type ApiErrorBody } from '@app/shared';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { createApiKeyService } from './api-keys/api-key-service.js';
import { createApiKeysRouter } from './api-keys/api-keys-router.js';
import { createAuthRouter } from './auth/auth-router.js';
import { createAuthService } from './auth/auth-service.js';
import { createMfaRouter } from './auth/mfa-router.js';
import { createMfaService } from './auth/mfa-service.js';
import { errorForLog } from './describe-error.js';
import { healthRouter, type ReadinessCheck } from './health.js';
import { HttpError } from './http/errors.js';
import { jsonOnly } from './http/json-only.js';
import type { Mailer } from './mail/mailer.js';
import { createProjectAccess } from './projects/project-access.js';
import { createProjectInvitationService } from './projects/project-invitations.js';
import { createProjectService } from './projects/project-service.js';
import { createProjectTransferService } from './projects/project-transfers.js';
import { createProjectsRouter } from './projects/projects-router.js';
import { createPublicApiRouter } from './public-api/public-api-router.js';
import { createInvitationService } from './users/invitations.js';
import { createMeRouter } from './users/me-router.js';
import { createUsersRouter } from './users/users-router.js';
import { createUserService } from './users/users-service.js';

export type { ReadinessCheck } from './health.js';

/**
 * Everything the HTTP layer needs, passed explicitly to every router factory. Routers must not touch
 * the database while being created: the app exists before start.ts has connected it.
 */
export type AppDeps = {
  config: AppConfig;
  checks: ReadinessCheck[];
  dataSource: DataSource;
  mailer: Mailer;
  /** Required in queue mode: shared rate-limit counters across instances. */
  redis?: Redis;
};

export function createApp(deps: AppDeps): express.Express {
  if (deps.config.executionsMode === 'queue' && !deps.redis) {
    throw new Error('A Redis client is required in queue mode');
  }
  const app = express();
  app.disable('x-powered-by');
  // Behind N load balancers/proxies req.ip comes from X-Forwarded-For (rate limits key on it).
  if (deps.config.proxyHops > 0) app.set('trust proxy', deps.config.proxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Only behind https: over plain http (e.g. the Docker app opened on a LAN IP) the browser would
          // rewrite every script and style URL to https and load nothing.
          upgradeInsecureRequests: deps.config.editorBaseUrl.startsWith('https://') ? [] : null,
        },
      },
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '16mb' }));

  app.use(healthRouter(deps.checks, { metrics: deps.config.metricsEnabled }));

  // One instance of each service per app, shared by all routers: e.g. the per-user limit on failed 2FA
  // codes must count login, password reset and the 2FA settings together.
  const mfa = createMfaService(deps);
  const auth = createAuthService({ ...deps, mfa });
  // The single gate to project data; later services (workflows, credentials, …) take it as a dependency.
  const access = createProjectAccess(deps.dataSource);
  const projects = createProjectService({ ...deps, access });
  const projectInvitations = createProjectInvitationService({ ...deps, access });
  const projectTransfers = createProjectTransferService({ ...deps, access, auth });
  const users = createUserService(deps);
  const invitations = createInvitationService(deps);
  const apiKeys = createApiKeyService(deps);

  // Internal API of the editor (n8n: /rest). Later routers are appended to `restRouters`.
  const restRouters: express.Router[] = [
    createAuthRouter(deps, { auth }),
    createMfaRouter(deps, { auth, mfa }),
    createMeRouter(deps, { auth }),
    createProjectsRouter(deps, { projects, invitations: projectInvitations, transfers: projectTransfers }),
    createUsersRouter(deps, { auth, users, invitations }),
    createApiKeysRouter(deps, { apiKeys }),
  ];
  const rest = express.Router();
  rest.use(jsonOnly);
  rest.get('/version', (_req, res) => {
    res.json({ name: APP_NAME, version: APP_VERSION });
  });
  for (const router of restRouters) rest.use(router);
  rest.use((_req, res) => {
    res.status(404).json({ message: 'Not found' });
  });
  app.use('/rest', rest);

  // Public API (API key in `X-API-KEY`, never the session cookie). Anything else under /api — e.g. a
  // future /api/v2 — is a JSON 404, never the editor page.
  app.use('/api/v1', createPublicApiRouter(deps, { apiKeys, projects }));
  app.use('/api', (_req, res) => {
    res.status(404).json({ message: 'Not found' });
  });

  const editorDist = deps.config.editorDistPath;
  if (editorDist) {
    app.use(express.static(editorDist, { index: false }));
    // SPA fallback: every non-API GET renders the editor; the client router takes it from there.
    app.get(/^(?!\/(rest|api|healthz|metrics)(\/|$)).*/, (req, res) => {
      // A file that is not there (e.g. a chunk of an older build after a deploy) is a 404, never the
      // editor page: served as JavaScript, HTML only fails later with a confusing MIME type error.
      if (isAssetPath(req.path)) {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      res.sendFile(path.join(editorDist, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}

/** Requests for built files: anything under /assets/ or with a file extension in its last segment. */
function isAssetPath(urlPath: string): boolean {
  if (urlPath === '/assets' || urlPath.startsWith('/assets/')) return true;
  const lastSegment = urlPath.slice(urlPath.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]+$/.test(lastSegment);
}

/**
 * Last resort: JSON errors only, never a stack trace (Express' default HTML page leaks it in development).
 * A 4xx HttpError is shown to the client as is; anything else gets a generic message.
 */
export function errorHandler(
  error: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
    res.status(error.status).json({
      ...error.extra,
      message: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
    } satisfies ApiErrorBody);
    return;
  }
  const status = httpStatusOf(error);
  if (status >= 500) console.error(errorForLog(error));
  res.status(status).json({
    message: status === 400 && isJsonParseError(error) ? 'Invalid JSON body' : messageFor(status),
  } satisfies ApiErrorBody);
}

function httpStatusOf(error: unknown): number {
  const status =
    (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

function isJsonParseError(error: unknown): boolean {
  return (error as { type?: unknown }).type === 'entity.parse.failed';
}

function messageFor(status: number): string {
  if (status === 413) return 'Request body too large';
  if (status === 503) return 'Service unavailable';
  return status >= 500 ? 'Internal server error' : 'Bad request';
}
