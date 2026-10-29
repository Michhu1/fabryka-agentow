import type { Logger } from 'typeorm';

/**
 * TypeORM's default logger prints `-- PARAMETERS: [...]` with every failed query, which puts password
 * hashes, emails and tokens into the logs. This one logs the SQL text (placeholders only) and the error
 * message, never the parameters.
 */
export class SafeTypeormLogger implements Logger {
  logQuery(_query: string, _parameters?: unknown[] | object): void {}

  logQueryError(error: string | Error, query: string, _parameters?: unknown[] | object): void {
    const message = typeof error === 'string' ? error : error.message;
    console.error(`query failed: ${query} -- ${message}`);
  }

  logQuerySlow(time: number, query: string, _parameters?: unknown[] | object): void {
    console.warn(`slow query (${time} ms): ${query}`);
  }

  logSchemaBuild(): void {}

  logMigration(): void {}

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (level === 'warn') console.warn(message);
  }
}
