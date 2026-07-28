import { describe, it, expect, vi, beforeEach } from 'vitest';

// notify.ts builds a Supabase client + Twilio/Resend/APNs/web-push clients at
// module scope, so the dispatcher's collaborators are stubbed here. What's
// under test is the targeting (super admins, minus the importer) and the
// payload, not the delivery channels themselves.
const superAdminIds = vi.fn(async (_exclude?: string | null) => [] as string[]);
const notifyManyMock = vi.fn(async (_ids: string[], _payload: any) => {});

vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: (exclude?: string | null) => superAdminIds(exclude),
  notifyMany: (ids: string[], payload: any) => notifyManyMock(ids, payload),
}));

import {
  buildPoImportNotification,
  countGraphicsLines,
  isGraphicsPartNumber,
  notifyPoImported,
} from './po-import-notify';

/** Minimal profiles lookup: supabase.from('profiles').select().eq().maybeSingle() */
function supabaseWithProfile(profile: any) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: profile }) }),
      }),
    }),
  };
}

beforeEach(() => {
  superAdminIds.mockReset();
  superAdminIds.mockResolvedValue([]);
  notifyManyMock.mockReset();
});

describe('isGraphicsPartNumber', () => {
  it('matches 02* and RM* part numbers, case-insensitively', () => {
    expect(isGraphicsPartNumber('02T278')).toBe(true);
    expect(isGraphicsPartNumber('RM530432')).toBe(true);
    expect(isGraphicsPartNumber('rm530432')).toBe(true);
    expect(isGraphicsPartNumber(' 02T278 ')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isGraphicsPartNumber('06T278')).toBe(false);
    expect(isGraphicsPartNumber('X02T278')).toBe(false);
    expect(isGraphicsPartNumber(null)).toBe(false);
    expect(isGraphicsPartNumber(undefined)).toBe(false);
    expect(isGraphicsPartNumber('')).toBe(false);
  });
});

describe('countGraphicsLines', () => {
  it('counts only the graphics lines', () => {
    expect(
      countGraphicsLines([
        { part_number: '02T278' },
        { part_number: '06T278' },
        { part_number: 'RM530432' },
        { part_number: null },
      ]),
    ).toBe(2);
  });

  it('handles an empty or missing list', () => {
    expect(countGraphicsLines([])).toBe(0);
    expect(countGraphicsLines(undefined as any)).toBe(0);
  });
});

describe('buildPoImportNotification', () => {
  it('names the importer and flags that a graphics job may be needed', () => {
    const { title, body } = buildPoImportNotification({
      poNumber: '35045953',
      customer: 'Masterack',
      actorName: 'Jamie Rivera',
      lineCount: 12,
      graphicsCount: 3,
    });
    expect(title).toBe('PO #35045953 imported by Jamie Rivera');
    expect(body).toBe('Masterack · 12 line items · 3 graphics parts — graphics job may be needed');
  });

  it('says so plainly when there are no graphics parts', () => {
    const { body } = buildPoImportNotification({
      poNumber: '1',
      customer: 'Masterack',
      actorName: 'Jamie',
      lineCount: 1,
      graphicsCount: 0,
    });
    expect(body).toBe('Masterack · 1 line item · no graphics parts');
  });

  it('uses "updated" wording when an existing PO was overwritten', () => {
    const { title } = buildPoImportNotification({
      poNumber: '35045953',
      customer: 'Masterack',
      actorName: 'Jamie',
      lineCount: 4,
      graphicsCount: 1,
      updated: true,
    });
    expect(title).toBe('PO #35045953 updated by Jamie');
  });

  it('falls back gracefully with no actor name or customer', () => {
    const { title, body } = buildPoImportNotification({
      poNumber: '77',
      customer: null,
      actorName: '  ',
      lineCount: 2,
      graphicsCount: 0,
    });
    expect(title).toBe('PO #77 imported by someone');
    expect(body).toBe('2 line items · no graphics parts');
  });
});

describe('notifyPoImported', () => {
  const args = {
    poId: 'po-uuid',
    poNumber: '35045953',
    customer: 'Masterack',
    lineCount: 5,
    graphicsCount: 2,
    actorId: 'importer-id',
  };

  it('alerts every super admin except the importer, on in-app + email + push', async () => {
    superAdminIds.mockResolvedValue(['admin-a', 'admin-b']);
    const supabase = supabaseWithProfile({ full_name: 'Jamie Rivera', email: 'jamie@bmgfleet.com' });

    const count = await notifyPoImported(supabase, args);

    expect(count).toBe(2);
    expect(superAdminIds).toHaveBeenCalledWith('importer-id');
    const [ids, payload] = notifyManyMock.mock.calls[0];
    expect(ids).toEqual(['admin-a', 'admin-b']);
    expect(payload.type).toBe('po_imported');
    expect(payload.title).toBe('PO #35045953 imported by Jamie Rivera');
    expect(payload.url).toBe('/admin/pos?id=po-uuid');
    expect(payload.channels).toEqual(['in_app', 'email', 'push']);
    expect(payload.forceChannels).toBe(true);
  });

  it('falls back to the importer email when they have no name set', async () => {
    superAdminIds.mockResolvedValue(['admin-a']);
    const supabase = supabaseWithProfile({ full_name: null, email: 'jamie@bmgfleet.com' });

    await notifyPoImported(supabase, args);

    expect(notifyManyMock.mock.calls[0][1].title).toBe('PO #35045953 imported by jamie@bmgfleet.com');
  });

  it('stays silent for server-to-server imports (no human actor)', async () => {
    const supabase = supabaseWithProfile({ full_name: 'Jamie' });

    const count = await notifyPoImported(supabase, { ...args, actorId: null });

    expect(count).toBe(0);
    expect(notifyManyMock).not.toHaveBeenCalled();
  });

  it('sends nothing when there are no super admins to tell', async () => {
    superAdminIds.mockResolvedValue([]);
    const supabase = supabaseWithProfile({ full_name: 'Jamie' });

    expect(await notifyPoImported(supabase, args)).toBe(0);
    expect(notifyManyMock).not.toHaveBeenCalled();
  });

  it('swallows failures so a broken notification never fails the import', async () => {
    superAdminIds.mockRejectedValue(new Error('supabase down'));
    const supabase = supabaseWithProfile({ full_name: 'Jamie' });

    await expect(notifyPoImported(supabase, args)).resolves.toBe(0);
  });
});
