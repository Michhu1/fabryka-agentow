import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithRetry } from './connect-with-retry.js';

describe('connectWithRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries then succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return 42;
    };
    const promise = connectWithRetry(fn, { attempts: 5, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(42);
    expect(calls).toBe(3);
  });

  it('gives up after attempts and rethrows the last error', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error(`fail ${calls}`);
    };
    const promise = connectWithRetry(fn, { attempts: 5, baseDelayMs: 100 });
    const assertion = expect(promise).rejects.toThrow('fail 5');
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(5);
  });
});
