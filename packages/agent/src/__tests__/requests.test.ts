import { describe, expect, it } from '@jest/globals';

import { redactUrl } from '../requests';

describe('redactUrl', () => {
  it('keeps the shape of a query string but hides secrets', () => {
    expect(redactUrl('https://api/x?page=2&token=abc&otp=123456#f')).toBe('https://api/x?page=2&token=…&otp=…#f');
  });
});
