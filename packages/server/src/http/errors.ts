import { z } from 'zod';

/**
 * An error meant for the client. For 4xx the app error handler answers `{ ...extra, message, code? }`;
 * a 5xx HttpError is treated like any other internal error (logged, generic message).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable code for the client (e.g. `MFA_REQUIRED_CODE` from @app/shared, same as n8n). */
    readonly code?: number,
    /** Extra JSON fields for the body, e.g. `{ projects: [...] }` on a 409. */
    readonly extra?: Record<string, unknown>,
    /** The underlying error, for the server log only. */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
  }
}

/** Parses `input` with `schema`; on failure throws 400 with the first issue's message. */
export function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

/**
 * Objects that refuse unknown keys: a client sending `{ role: 'global:owner' }` or `{ mfaEnabled: false }`
 * gets a 400 instead of having it silently ignored, and no later change can let such a field through.
 */
export function strictBody<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys' ? `Unknown field: ${issue.keys[0]}` : 'Invalid request body',
  });
}
