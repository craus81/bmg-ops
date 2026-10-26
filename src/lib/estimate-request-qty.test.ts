import { describe, it, expect } from 'vitest';
import { startingRequestQty } from './estimate-request-qty';

describe('startingRequestQty', () => {
  it('starts lines that need ordering at the suggested quantity', () => {
    expect(startingRequestQty({ needed: 4, requested: 0, to_request: 3 })).toBe(3);
  });
  it('starts in-stock lines at the full estimate quantity less what is requested', () => {
    expect(startingRequestQty({ needed: 4, requested: 0, to_request: 0 })).toBe(4);
    expect(startingRequestQty({ needed: 4, requested: 1, to_request: 0 })).toBe(3);
  });
  it('falls back to the full quantity when the line is already all requested', () => {
    expect(startingRequestQty({ needed: 4, requested: 4, to_request: 0 })).toBe(4);
  });
});
