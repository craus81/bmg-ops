import { describe, it, expect, vi, beforeEach } from 'vitest';

const suiteql = vi.fn();
const createContact = vi.fn();
const updateContact = vi.fn();
vi.mock('@/lib/netsuite', () => ({
  suiteqlQuery: (...a: any[]) => suiteql(...a),
  createContact: (...a: any[]) => createContact(...a),
  updateContact: (...a: any[]) => updateContact(...a),
}));

import { pushProspectContactToNetsuite } from './prospect-contact-netsuite';

function fakeSupabase() {
  const links: Array<{ values: any; id: string }> = [];
  const supabase: any = {
    from: () => ({
      update: (values: any) => ({ eq: async (_c: string, id: string) => { links.push({ values, id }); return { error: null }; } }),
    }),
  };
  return { supabase, links };
}

const row = (r: Partial<{ id: string; entityid: string; firstname: string; lastname: string; company: string; company_name: string }>) => r;

beforeEach(() => {
  suiteql.mockReset();
  createContact.mockReset();
  updateContact.mockReset().mockResolvedValue({ success: true });
});

describe('pushProspectContactToNetsuite', () => {
  it('PATCHes a linked contact without looking anything up', async () => {
    const { supabase } = fakeSupabase();
    const r = await pushProspectContactToNetsuite(supabase, '77', { id: 'c1', name: 'Jane Doe', netsuite_contact_id: '500' });
    expect(r).toEqual({ pushed: true, error: null });
    expect(updateContact).toHaveBeenCalledWith('500', expect.objectContaining({ firstName: 'Jane', lastName: 'Doe' }));
    expect(suiteql).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
  });

  it('links and updates an unlinked contact NetSuite already has on the customer', async () => {
    suiteql.mockResolvedValue({ items: [row({ id: '501', firstname: 'Jane', lastname: 'Doe', company: '77' })] });
    const { supabase, links } = fakeSupabase();
    const contact: any = { id: 'c1', name: 'Jane Doe', phone: '555' };
    const r = await pushProspectContactToNetsuite(supabase, '77', contact);
    expect(r.pushed).toBe(true);
    expect(createContact).not.toHaveBeenCalled();
    expect(updateContact).toHaveBeenCalledWith('501', expect.objectContaining({ phone: '555' }));
    expect(links).toEqual([{ values: { netsuite_contact_id: '501' }, id: 'c1' }]);
    expect(contact.netsuite_contact_id).toBe('501');
  });

  it('on a rename, finds the contact by its previous name and renames it in NetSuite', async () => {
    suiteql.mockResolvedValue({ items: [
      row({ id: '600', firstname: 'Jon', lastname: 'Smith', company: '77' }),
      row({ id: '601', firstname: 'John', lastname: 'Smith', company: '77' }),
    ] });
    const { supabase } = fakeSupabase();
    await pushProspectContactToNetsuite(supabase, '77', { id: 'c1', name: 'John Smith' }, 'Jon Smith');
    expect(suiteql.mock.calls[0][0]).toContain("'jon smith', 'john smith'");
    expect(updateContact).toHaveBeenCalledWith('600', expect.objectContaining({ firstName: 'John', lastName: 'Smith' }));
  });

  it('creates and links when NetSuite has no match', async () => {
    suiteql.mockResolvedValue({ items: [] });
    createContact.mockResolvedValue({ success: true, internalId: '900' });
    const { supabase, links } = fakeSupabase();
    const r = await pushProspectContactToNetsuite(supabase, '77', { id: 'c1', name: "Pat O'Neil" });
    expect(suiteql.mock.calls[0][0]).toContain("'pat o''neil'");
    expect(r.pushed).toBe(true);
    expect(links[0].values).toEqual({ netsuite_contact_id: '900' });
  });

  it('names the other customer when the name is taken elsewhere', async () => {
    suiteql.mockResolvedValue({ items: [row({ id: '700', firstname: 'Jane', lastname: 'Doe', company: '12', company_name: 'Acme Fleet' })] });
    createContact.mockResolvedValue({ success: false, error: 'NetSuite 400: A contact record with this name already exists.' });
    const { supabase, links } = fakeSupabase();
    const r = await pushProspectContactToNetsuite(supabase, '77', { id: 'c1', name: 'Jane Doe' });
    expect(r.pushed).toBe(false);
    expect(r.error).toContain('on "Acme Fleet"');
    expect(updateContact).not.toHaveBeenCalled();
    expect(links).toEqual([]);
  });

  it('falls back to create when the lookup itself fails', async () => {
    suiteql.mockRejectedValue(new Error('NetSuite SuiteQL error (400)'));
    createContact.mockResolvedValue({ success: true, internalId: '901' });
    const { supabase } = fakeSupabase();
    const r = await pushProspectContactToNetsuite(supabase, '77', { id: 'c1', name: 'Jane Doe' });
    expect(r.pushed).toBe(true);
    expect(createContact).toHaveBeenCalled();
  });
});
