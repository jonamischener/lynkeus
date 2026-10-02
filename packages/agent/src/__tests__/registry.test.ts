import { describe, expect, it } from '@jest/globals';

import { host, qa } from '../registry';

describe('qa.register', () => {
  it('exposes app commands by name, sorted', () => {
    const off = qa.register('reset', () => 'done');
    qa.register('busy', () => false);
    expect(host.commands()).toEqual(['busy', 'events', 'profile', 'reset', 'stores']);
    off();
    expect(host.commands()).toEqual(['busy', 'events', 'profile', 'stores']);
    qa.unregister('busy');
  });

  it('rejects names that could not be addressed', () => {
    expect(() => qa.register('../x', () => null)).toThrow(/Invalid command name/);
  });
});
