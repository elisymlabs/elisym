import { version } from 'react';
import { describe, expect, it } from 'vitest';

describe('the React under test', () => {
  it('is the major this run is for', () => {
    expect(version.split('.')[0]).toBe(process.env.EXPECT_REACT_MAJOR ?? '19');
  });
});
