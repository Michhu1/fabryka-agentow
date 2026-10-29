import { ConfigError, loadConfig } from '@app/config';
import { installShutdown } from './shutdown.js';
import { StartupError, start } from './start.js';

try {
  const config = loadConfig();
  const running = await start(config);
  console.log(`Server ready on http://localhost:${config.port}`);
  installShutdown({
    close: running.close,
    exit: (code) => process.exit(code),
    log: (message) => console.error(message),
    signals: process,
  });
} catch (error) {
  if (error instanceof ConfigError || error instanceof StartupError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
