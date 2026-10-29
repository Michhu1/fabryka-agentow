import { describe, expect, it } from 'vitest';
import { hardenSession, isExternal } from './security.js';

describe('hardenSession', () => {
  it('denies every permission request and check', () => {
    let request:
      | ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | undefined;
    let check: ((wc: unknown, permission: string) => boolean) | undefined;
    const fakeSession = {
      setPermissionRequestHandler: (h: typeof request) => {
        request = h;
      },
      setPermissionCheckHandler: (h: typeof check) => {
        check = h;
      },
    };
    hardenSession(fakeSession);
    let granted: boolean | undefined;
    request?.(null, 'media', (g) => {
      granted = g;
    });
    expect(granted).toBe(false);
    expect(check?.(null, 'geolocation')).toBe(false);
  });
});

describe('isExternal', () => {
  it('treats other origins and garbage as external', () => {
    expect(isExternal('https://evil.example/x', 'http://localhost:5680')).toBe(true);
    expect(isExternal('not a url', 'http://localhost:5680')).toBe(true);
    expect(isExternal('http://localhost:5680/workflows', 'http://localhost:5680')).toBe(false);
  });
});
