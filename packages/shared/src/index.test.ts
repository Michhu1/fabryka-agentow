import { describe, expect, it } from 'vitest';
import { API_KEYS_LIMIT, APP_NAME, APP_VERSION, MFA_REQUIRED_CODE } from './index.js';

describe('app identity', () => {
  it('exposes the working app name', () => {
    expect(APP_NAME).toBe('moj-n8n');
  });

  it('exposes a semver version', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('version sync', () => {
  it('matches the root package.json version', async () => {
    const { readFile } = await import('node:fs/promises');
    const root = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(APP_VERSION).toBe(root.version);
  });
});

describe('shared constants', () => {
  it('exposes the values the server and the editor agree on', () => {
    expect(MFA_REQUIRED_CODE).toBe(998);
    expect(API_KEYS_LIMIT).toBe(10);
  });
});
