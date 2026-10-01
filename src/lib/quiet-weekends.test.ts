import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isShopWeekend, markWeekendSkip } from './quiet-weekends';

describe('isShopWeekend', () => {
  it('uses the shop clock, not UTC', () => {
    // Friday 11pm Central = Saturday 04:00 UTC: still Friday in the shop.
    expect(isShopWeekend(new Date('2026-10-03T04:00:00Z'))).toBe(false);
    // Sunday 11pm Central = Monday 04:00 UTC: still Sunday in the shop.
    expect(isShopWeekend(new Date('2026-10-05T04:00:00Z'))).toBe(true);
  });

  it('is true on Saturday and Sunday only', () => {
    expect(isShopWeekend(new Date('2026-10-02T14:00:00Z'))).toBe(false); // Fri
    expect(isShopWeekend(new Date('2026-10-03T14:00:00Z'))).toBe(true);  // Sat
    expect(isShopWeekend(new Date('2026-10-04T14:00:00Z'))).toBe(true);  // Sun
    expect(isShopWeekend(new Date('2026-10-05T14:00:00Z'))).toBe(false); // Mon
  });
});

describe('markWeekendSkip', () => {
  it('moves only updated_at, leaving last_result for the next real run', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    await markWeekendSkip({ from } as unknown as SupabaseClient, 'at_risk_check');
    expect(from).toHaveBeenCalledWith('sync_state');
    expect(Object.keys(update.mock.calls[0][0])).toEqual(['updated_at']);
    expect(eq).toHaveBeenCalledWith('sync_type', 'at_risk_check');
  });
});
