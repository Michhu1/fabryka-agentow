import { describe, expect, it } from 'vitest';
import { describeError } from './describe-error.js';

describe('describeError', () => {
  it('uses the message when present', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the error code when the message is empty', () => {
    const error = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(describeError(error)).toBe('ECONNREFUSED');
  });

  it('looks inside an empty AggregateError', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED ::1:5433'), { code: 'ECONNREFUSED' });
    expect(describeError(new AggregateError([inner], ''))).toBe('ECONNREFUSED');
  });

  it('never returns an empty string', () => {
    expect(describeError(new Error(''))).toBe('unknown error');
    expect(describeError('weird')).toBe('weird');
  });
});
