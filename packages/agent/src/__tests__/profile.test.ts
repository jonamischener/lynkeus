import { describe, expect, it } from '@jest/globals';

import { readProfile, recordCommit } from '../profile';

describe('profile', () => {
  it('keeps nothing until started, then adds up what React spent rendering per route', () => {
    recordCommit(99, 'Feed.Main');
    expect(readProfile({})).toEqual({ recording: false, commits: 0, ms: 0, routes: {} });
    readProfile({ action: 'start' });
    recordCommit(12, 'Feed.Main');
    recordCommit(3, 'Feed.Main');
    recordCommit(5.5, 'Settings.Main');

    expect(readProfile({})).toEqual({
      recording: true,
      commits: 3,
      ms: 20.5,
      routes: {
        'Feed.Main': { commits: 2, ms: 15, maxMs: 12 },
        'Settings.Main': { commits: 1, ms: 5.5, maxMs: 5.5 },
      },
    });
    readProfile({ action: 'stop' });
    recordCommit(7, 'Feed.Main');
    expect(readProfile({})).toMatchObject({ recording: false, commits: 3 });
  });
});
