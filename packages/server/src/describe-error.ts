/**
 * One-line, never-empty description of an error. Node's network errors (e.g. pg connecting to
 * "localhost" that resolves to both ::1 and 127.0.0.1) can be an AggregateError with an empty message.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError && !error.message && error.errors.length > 0) {
    return describeError(error.errors[0]);
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return error.message && !code ? error.message : (code ?? (error.message || 'unknown error'));
  }
  return String(error) || 'unknown error';
}

/**
 * Name, message and stack of an error for the server log — and nothing else. Logging the error object
 * itself would also print fields like a QueryFailedError's `parameters` (password hashes, emails) or
 * the pg driver's `detail` ("Key (email)=(...) already exists").
 */
export function errorForLog(error: unknown): string {
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`;
    const stack = error.stack?.startsWith(head) ? error.stack : `${head}\n${error.stack ?? ''}`;
    const cause = error.cause === undefined ? '' : `\nCaused by: ${errorForLog(error.cause)}`;
    return `${stack.trimEnd()}${cause}`;
  }
  return describeError(error);
}
