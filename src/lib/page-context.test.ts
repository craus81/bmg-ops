import { describe, it, expect } from 'vitest';
import { describePage, pageContextBlock } from './page-context';

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('describePage', () => {
  it('reads a record id out of a path segment', () => {
    expect(describePage(`/admin/pos/${UUID}`)).toEqual({
      label: 'a customer purchase order',
      record: { kind: 'purchase order', table: 'purchase_orders', column: 'id', id: UUID, idKind: 'uuid' },
    });
  });

  it('reads a record id out of a query param', () => {
    const ctx = describePage('/estimates', `?id=${UUID}&note=field`);
    expect(ctx?.record).toEqual({ kind: 'estimate', table: 'estimates', column: 'id', id: UUID, idKind: 'uuid' });
  });

  it('prefers the more specific route', () => {
    expect(describePage('/vehicles/1FTBW3XM6PKA12345/pick-list')?.label).toBe('a vehicle’s pick list / job card');
    expect(describePage('/vehicles/1FTBW3XM6PKA12345')?.label).toBe('a vehicle record');
    expect(describePage(`/admin/prospects/ns-48210`)?.record)
      .toEqual({ kind: 'customer', table: 'customers', column: 'netsuite_id', id: '48210', idKind: 'netsuite_id' });
  });

  it('keeps the screen but drops a malformed id', () => {
    // Nothing from the path is ever carried across unvalidated — this is the
    // guard that keeps a client-supplied URL out of the prompt.
    const ctx = describePage('/admin/pos/../../etc/passwd');
    expect(ctx?.record ?? null).toBeNull();
    expect(describePage('/estimates', '?id=1;DROP TABLE estimates')?.record ?? null).toBeNull();
    expect(describePage('/vehicles/IOQ0000000000')?.record ?? null).toBeNull();
    expect(describePage('/admin/prospects/not-a-uuid')?.record ?? null).toBeNull();
  });

  it('describes a list screen with no record', () => {
    expect(describePage('/graphics')).toEqual({ label: 'the Graphics production board', record: null });
    expect(describePage('/estimates')).toEqual({ label: 'the Estimates builder', record: null });
  });

  it('never describes a private conversation', () => {
    expect(describePage('/messages', `?conversation=${UUID}`)).toBeNull();
  });

  it('returns null for a route it does not know', () => {
    expect(describePage('/some/page/that/does/not/exist')).toBeNull();
    expect(describePage('')).toBeNull();
    expect(describePage(null)).toBeNull();
    expect(describePage('https://evil.test/admin/pos/x')).toBeNull();
  });

  it('normalizes a trailing slash, a hash, and a query smuggled into the path', () => {
    expect(describePage('/graphics/')?.label).toBe('the Graphics production board');
    expect(describePage('/graphics#top')?.label).toBe('the Graphics production board');
    expect(describePage('/graphics?x=1')?.label).toBe('the Graphics production board');
  });
});

describe('pageContextBlock', () => {
  it('is empty when there is no context, so callers can concatenate freely', () => {
    expect(pageContextBlock(null)).toBe('');
  });

  it('names the record and insists the model actually reads it', () => {
    const block = pageContextBlock(describePage(`/admin/pos/${UUID}`));
    expect(block).toContain('a customer purchase order');
    expect(block).toContain(`id = '${UUID}'`);
    expect(block).toContain('purchase_orders');
    expect(block).toContain('this is a pointer, not data');
    expect(block).toContain('could not be read');
  });

  it('tells the model to ask rather than pick when no record is identified', () => {
    const block = pageContextBlock(describePage('/graphics'));
    expect(block).toContain('do not pick one');
    expect(block).not.toContain('pointer');
  });
});
