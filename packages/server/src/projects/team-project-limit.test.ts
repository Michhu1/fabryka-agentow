import { describe, expect, it } from 'vitest';
import { effectiveTeamProjectsLimit } from './team-project-limit.js';

describe('effectiveTeamProjectsLimit', () => {
  it('NULL on the account → the instance default', () => {
    expect(effectiveTeamProjectsLimit({ teamProjectsLimit: null }, { teamProjectsLimit: 3 })).toBe(3);
  });

  it("the account's own value wins, higher or lower, 0 included", () => {
    expect(effectiveTeamProjectsLimit({ teamProjectsLimit: 5 }, { teamProjectsLimit: 3 })).toBe(5);
    expect(effectiveTeamProjectsLimit({ teamProjectsLimit: 1 }, { teamProjectsLimit: 3 })).toBe(1);
    expect(effectiveTeamProjectsLimit({ teamProjectsLimit: 0 }, { teamProjectsLimit: 3 })).toBe(0);
  });
});
