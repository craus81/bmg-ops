import { describe, it, expect } from 'vitest';
import { apiErrorMessage } from './api-error-message';

describe('apiErrorMessage', () => {
  it('returns the error string when there are no details', () => {
    expect(apiErrorMessage({ error: 'Nope' })).toBe('Nope');
  });
  it('falls back when the body has no usable error', () => {
    expect(apiErrorMessage({})).toBe('Unknown error');
    expect(apiErrorMessage(null, 'Create failed')).toBe('Create failed');
    expect(apiErrorMessage({ error: '' }, 'Create failed')).toBe('Create failed');
  });
  it('names the rejected field from validateBody() details', () => {
    const body = {
      error: 'Invalid request',
      details: [{ path: 'line_items.0.labor_hours', message: 'Invalid input' }],
    };
    expect(apiErrorMessage(body)).toBe('Invalid request (line_items.0.labor_hours: Invalid input)');
  });
  it('joins several details and skips empty ones', () => {
    const body = { error: 'Invalid request', details: [{ path: 'a', message: 'x' }, {}, { path: 'b', message: 'y' }] };
    expect(apiErrorMessage(body)).toBe('Invalid request (a: x; b: y)');
  });
});
