import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './index.js';

const KEY = 'x'.repeat(32);

describe('loadConfig', () => {
  it('loads defaults for development', () => {
    const config = loadConfig({ NODE_ENV: 'development', ENCRYPTION_KEY: KEY });
    expect(config.port).toBe(5680);
    expect(config.executionsMode).toBe('regular');
    expect(config.db.port).toBe(5433);
    expect(config.redis.url).toBe('redis://localhost:6380');
    expect(config.publicMode).toBe(true);
  });

  it('reports all invalid keys by name without values', () => {
    let error: unknown;
    try {
      loadConfig({ PORT: 'abc', EXECUTIONS_MODE: 'turbo', ENCRYPTION_KEY: 'secret-short' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.invalidKeys).toEqual(['ENCRYPTION_KEY', 'EXECUTIONS_MODE', 'PORT']);
    expect(configError.message).not.toContain('secret-short');
    expect(configError.message).not.toContain('abc');
  });

  it('refuses production without ENCRYPTION_KEY', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (e) {
      expect((e as ConfigError).invalidKeys).toContain('ENCRYPTION_KEY');
    }
  });

  it('webhookUrl defaults to publicUrl', () => {
    const config = loadConfig({ ENCRYPTION_KEY: KEY, PUBLIC_URL: 'https://x.example' });
    expect(config.webhookUrl).toBe('https://x.example');
  });

  it('parses booleans', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY, PUBLIC_MODE: 'false' }).publicMode).toBe(false);
    expect(() => loadConfig({ ENCRYPTION_KEY: KEY, PUBLIC_MODE: 'yes' })).toThrow(ConfigError);
  });
});

describe('production secrets', () => {
  const prod = {
    NODE_ENV: 'production',
    ENCRYPTION_KEY: 'p'.repeat(40),
    DB_POSTGRESDB_PASSWORD: 'real-db-password',
    S3_ACCESS_KEY: 'real-access',
    S3_SECRET_KEY: 'real-secret',
  };

  it('accepts explicit production secrets', () => {
    expect(loadConfig(prod).env).toBe('production');
  });

  it('production rejects the published dev encryption key', () => {
    const error = (() => {
      try {
        loadConfig({ ...prod, ENCRYPTION_KEY: 'dev-only-change-me-dev-only-change-me' });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.invalidKeys).toEqual(['ENCRYPTION_KEY']);
  });

  it('production requires explicit db password and s3 keys', () => {
    const { DB_POSTGRESDB_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY, ...rest } = prod;
    const error = (() => {
      try {
        loadConfig(rest);
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(error?.invalidKeys).toEqual(['DB_POSTGRESDB_PASSWORD', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']);
  });

  it('production rejects the dev s3 keys', () => {
    expect(() =>
      loadConfig({ ...prod, S3_ACCESS_KEY: 'devaccesskey', S3_SECRET_KEY: 'devsecretkey' }),
    ).toThrow(ConfigError);
  });
});

describe('paths and tls', () => {
  it('resolves a relative EDITOR_DIST_PATH to an absolute path', async () => {
    const { isAbsolute } = await import('node:path');
    const config = loadConfig({ ENCRYPTION_KEY: KEY, EDITOR_DIST_PATH: 'packages/editor/dist' });
    expect(isAbsolute(config.editorDistPath ?? '')).toBe(true);
    expect(config.editorDistPath?.replaceAll('\\', '/')).toMatch(/packages\/editor\/dist$/);
  });

  it('reads an optional postgres CA certificate', () => {
    const config = loadConfig({ ENCRYPTION_KEY: KEY, DB_POSTGRESDB_SSL_CA: '-----BEGIN CERTIFICATE-----x' });
    expect(config.db.sslCa).toBe('-----BEGIN CERTIFICATE-----x');
  });
});

describe('accounts settings', () => {
  it('editorBaseUrl defaults to publicUrl', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY }).editorBaseUrl).toBe('http://localhost:5680');
    expect(loadConfig({ ENCRYPTION_KEY: KEY, PUBLIC_URL: 'https://x.example' }).editorBaseUrl).toBe(
      'https://x.example',
    );
  });

  it('reads EDITOR_BASE_URL without a trailing slash', () => {
    const config = loadConfig({ ENCRYPTION_KEY: KEY, EDITOR_BASE_URL: 'http://localhost:5681/' });
    expect(config.editorBaseUrl).toBe('http://localhost:5681');
    expect(() => loadConfig({ ENCRYPTION_KEY: KEY, EDITOR_BASE_URL: 'not a url' })).toThrow(ConfigError);
  });

  it('signup is enabled by default and can be turned off', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY }).signupEnabled).toBe(true);
    expect(loadConfig({ ENCRYPTION_KEY: KEY, SIGNUP_ENABLED: 'false' }).signupEnabled).toBe(false);
  });

  it('team projects limit defaults to 3 and rejects negatives', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY }).teamProjectsLimit).toBe(3);
    expect(loadConfig({ ENCRYPTION_KEY: KEY, TEAM_PROJECTS_LIMIT: '0' }).teamProjectsLimit).toBe(0);
    expect(() => loadConfig({ ENCRYPTION_KEY: KEY, TEAM_PROJECTS_LIMIT: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ENCRYPTION_KEY: KEY, TEAM_PROJECTS_LIMIT: '1.5' })).toThrow(ConfigError);
  });
});

describe('proxy hops', () => {
  it('defaults to 0 and reads PROXY_HOPS', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY }).proxyHops).toBe(0);
    expect(loadConfig({ ENCRYPTION_KEY: KEY, PROXY_HOPS: '2' }).proxyHops).toBe(2);
    expect(() => loadConfig({ ENCRYPTION_KEY: KEY, PROXY_HOPS: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ENCRYPTION_KEY: KEY, PROXY_HOPS: 'x' })).toThrow(ConfigError);
  });
});
