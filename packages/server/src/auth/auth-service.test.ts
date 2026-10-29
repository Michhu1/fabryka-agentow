import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { DUMMY_PASSWORD_HASH } from './auth-service.js';

describe('DUMMY_PASSWORD_HASH', () => {
  it('is a valid cost-10 bcrypt hash, so unknown emails cost as much as real ones', async () => {
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(10);
    expect(await bcrypt.compare('anything', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
