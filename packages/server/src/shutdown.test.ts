import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installShutdown } from './shutdown.js';

function setup(close: () => Promise<void>) {
  const proc = new EventEmitter();
  const exit = vi.fn();
  const log = vi.fn();
  installShutdown({ close, exit, log, signals: proc });
  return { proc, exit, log };
}

describe('installShutdown', () => {
  it('closes gracefully and exits 0 on the first signal', async () => {
    const close = vi.fn(async () => {});
    const { proc, exit } = setup(close);
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when closing fails', async () => {
    const { proc, exit, log } = setup(async () => {
      throw new Error('db stuck');
    });
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db stuck'));
  });

  it('forces exit 1 on a second signal while closing', () => {
    const { proc, exit } = setup(() => new Promise(() => {}));
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
