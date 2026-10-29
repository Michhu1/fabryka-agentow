import { describe, expect, it } from 'vitest';
import { resolveAppUrl } from './app-url.js';

describe('resolveAppUrl', () => {
  it('uses APP_URL when set', () => {
    expect(resolveAppUrl({ APP_URL: 'https://cloud.example' }, true)).toBe('https://cloud.example');
  });

  it('dev default is vite 5681', () => {
    expect(resolveAppUrl({}, false)).toBe('http://localhost:5681');
  });

  it('packaged default is server 5680', () => {
    expect(resolveAppUrl({}, true)).toBe('http://localhost:5680');
  });
});

describe('resolveAppUrl safety', () => {
  it('packaged app refuses plain http remote APP_URL', () => {
    expect(() => resolveAppUrl({ APP_URL: 'http://cloud.example' }, true)).toThrow(/https/);
  });

  it('packaged app allows http on loopback', () => {
    expect(resolveAppUrl({ APP_URL: 'http://127.0.0.1:5680' }, true)).toBe('http://127.0.0.1:5680');
  });
});
