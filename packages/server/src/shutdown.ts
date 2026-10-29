import type { EventEmitter } from 'node:events';
import { describeError } from './describe-error.js';

/**
 * First SIGINT/SIGTERM closes gracefully (exit 0, or 1 if closing fails);
 * a second signal while closing forces exit 1.
 */
export function installShutdown(deps: {
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  signals: Pick<EventEmitter, 'on'>;
}): void {
  let closing = false;
  const onSignal = () => {
    if (closing) {
      deps.log('Forced shutdown');
      deps.exit(1);
      return;
    }
    closing = true;
    deps.close().then(
      () => deps.exit(0),
      (error: unknown) => {
        deps.log(`Shutdown failed: ${describeError(error)}`);
        deps.exit(1);
      },
    );
  };
  deps.signals.on('SIGINT', onSignal);
  deps.signals.on('SIGTERM', onSignal);
}
