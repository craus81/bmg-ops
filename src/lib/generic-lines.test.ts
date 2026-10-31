import { describe, it, expect } from 'vitest';
import {
  genericDescKey, sameGenericLine, genericLineKey, groupGenericLines,
  requestReceivedQty, genericLineStatus, type GenericRequest, type GenericPoLine,
} from './generic-lines';

describe('genericDescKey / sameGenericLine', () => {
  it('ignores case, spacing and a kit tag', () => {
    expect(genericDescKey('  Diamond   Plate  [Rack R-12]')).toBe('diamond plate');
    expect(genericDescKey('Bracket [Hitch kit]')).toBe('bracket');
    expect(genericDescKey(null)).toBe('');
  });

  it('matches the SO memo that adds notes after the description', () => {
    expect(sameGenericLine('Diamond plate', 'diamond plate — cut to 48in')).toBe(true);
    expect(sameGenericLine('Diamond plate — cut to 48in', 'Diamond plate')).toBe(true);
    expect(sameGenericLine('Diamond plate', 'Rivets')).toBe(false);
    // "Diamond plate sheet" is not "Diamond plate" with notes.
    expect(sameGenericLine('Diamond plate', 'Diamond plate sheet')).toBe(false);
    expect(sameGenericLine('', '')).toBe(false);
  });
});

describe('groupGenericLines', () => {
  it('keeps each description its own row, in order — the EST-2610-076 bug', () => {
    const rows = groupGenericLines('MISC', [
      { description: 'Diamond plate', quantity: 2 },
      { description: 'Rivets', quantity: 3 },
      { description: 'Bracket', quantity: 1 },
    ]);
    expect(rows.map(r => [r.description, r.needed])).toEqual([
      ['Diamond plate', 2], ['Rivets', 3], ['Bracket', 1],
    ]);
  });

  it('adds up lines with the same description and drops zero lines', () => {
    const rows = groupGenericLines('MISC', [
      { description: 'Rivets', quantity: 3 },
      { description: 'rivets ', quantity: 2 },
      { description: 'Nothing', quantity: 0 },
    ]);
    expect(rows).toEqual([{ key: genericLineKey('MISC', 'Rivets'), description: 'Rivets', needed: 5 }]);
  });
});

const req = (over: Partial<GenericRequest>): GenericRequest => ({
  id: 'r1', item_number: 'MISC', description: 'Rivets', quantity: 3, status: 'pending', ...over,
});
const poLine = (over: Partial<GenericPoLine>): GenericPoLine => ({
  po_id: 'po1', item_number: 'MISC', description: 'Rivets', quantity_received: 0, ...over,
});

describe('requestReceivedQty', () => {
  it('Got it means all of it', () => {
    expect(requestReceivedQty(req({ status: 'ordered', received_at: '2026-10-31' }), [])).toBe(3);
  });

  it('reads its own PO line by description, capped at the request', () => {
    const lines = [poLine({ description: 'Diamond plate', quantity_received: 9 }), poLine({ quantity_received: 5 })];
    expect(requestReceivedQty(req({ status: 'ordered', ordered_po_id: 'po1' }), lines)).toBe(3);
    expect(requestReceivedQty(req({ status: 'ordered', ordered_po_id: 'po1', quantity: 9 }), lines)).toBe(5);
  });

  it('uses the only line of the item when no description matches', () => {
    const lines = [poLine({ description: 'MISC', quantity_received: 2 })];
    expect(requestReceivedQty(req({ status: 'ordered', ordered_po_id: 'po1' }), lines)).toBe(2);
  });

  it('never guesses between two lines, and pending requests have nothing in', () => {
    const lines = [poLine({ description: 'A', quantity_received: 2 }), poLine({ description: 'B', quantity_received: 2 })];
    expect(requestReceivedQty(req({ status: 'ordered', ordered_po_id: 'po1' }), lines)).toBe(0);
    expect(requestReceivedQty(req({}), [poLine({ quantity_received: 3 })])).toBe(0);
    expect(requestReceivedQty(req({ status: 'ordered', ordered_po_id: 'po2' }), [poLine({ quantity_received: 3 })])).toBe(0);
  });
});

describe('genericLineStatus', () => {
  const line = { needed: 3, description: 'Rivets' };

  it('is short with nothing behind it, and only its own description counts', () => {
    const st = genericLineStatus(line, [req({ description: 'Bracket', status: 'ordered', received_at: 'x' })], []);
    expect(st).toMatchObject({ state: 'short', short: 3, requested: 0, ordered: 0, received: 0, requestIds: [] });
  });

  it('pending is requested but still short', () => {
    expect(genericLineStatus(line, [req({})], [])).toMatchObject({ state: 'short', short: 3, requested: 3, requestIds: ['r1'] });
  });

  it('ordered on a PO is waiting, received is reserved', () => {
    const ordered = req({ status: 'ordered', ordered_po_id: 'po1' });
    expect(genericLineStatus(line, [ordered], [poLine({ quantity_received: 0 })]))
      .toMatchObject({ state: 'waiting', ordered: 3, received: 0, short: 0 });
    expect(genericLineStatus(line, [ordered], [poLine({ quantity_received: 1 })]))
      .toMatchObject({ state: 'waiting', ordered: 2, received: 1 });
    expect(genericLineStatus(line, [ordered], [poLine({ quantity_received: 3 })]))
      .toMatchObject({ state: 'reserved', ordered: 0, received: 3 });
  });

  it('ignores cancelled requests', () => {
    expect(genericLineStatus(line, [req({ status: 'cancelled', received_at: 'x' })], [])).toMatchObject({ state: 'short', received: 0 });
  });
});
