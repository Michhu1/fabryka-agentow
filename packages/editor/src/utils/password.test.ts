import { describe, expect, it } from 'vitest';
import { meetsPasswordPolicy } from './password';

describe('meetsPasswordPolicy', () => {
  it('matches the server policy', () => {
    expect(meetsPasswordPolicy('Haslo123')).toBe(true);
    expect(meetsPasswordPolicy('Łódź1234')).toBe(true);
    expect(meetsPasswordPolicy('haslo123')).toBe(false);
    expect(meetsPasswordPolicy('HasloHaslo')).toBe(false);
    expect(meetsPasswordPolicy('Ha1')).toBe(false);
    expect(meetsPasswordPolicy(`A1${'a'.repeat(63)}`)).toBe(false);
    expect(meetsPasswordPolicy(`A1${'ł'.repeat(40)}`)).toBe(false);
  });
});
