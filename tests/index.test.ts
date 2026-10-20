import { expect, test } from 'vitest';

import { scaffold } from '../src/index.js';

test('loads the dummy module', () => {
  expect(scaffold).toBe('dsh-arbiter');
});
