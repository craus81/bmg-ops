import { describe, it, expect } from 'vitest';
import { getProfileRoles } from './api-auth';

describe('getProfileRoles', () => {
  it('reads the legacy production role as graphics_production', () => {
    expect(getProfileRoles({ role: 'production', roles: null })).toEqual(['graphics_production']);
    expect(getProfileRoles({ role: 'sales', roles: ['production', 'sales'] })).toEqual(['graphics_production', 'sales']);
  });

  it('leaves other roles alone', () => {
    expect(getProfileRoles({ role: 'admin', roles: [] })).toEqual(['admin']);
  });
});
