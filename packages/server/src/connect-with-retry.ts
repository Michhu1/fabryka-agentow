const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls `fn` until it succeeds, waiting baseDelayMs * 2^n between attempts; rethrows the last error. */
export async function connectWithRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseDelayMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < opts.attempts - 1) await sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
