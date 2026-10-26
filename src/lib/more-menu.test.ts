import { describe, it, expect } from 'vitest';
import { MORE_GROUPS, orderMoreGroups, searchMorePages } from './more-menu';

const all = MORE_GROUPS.map(g => g.id);

describe('orderMoreGroups', () => {
  it('keeps the listed order for Everything', () => {
    expect(orderMoreGroups(['everything'])).toEqual(all);
  });
  it('puts a focus area first and keeps every group once', () => {
    const order = orderMoreGroups(['scheduling', 'purchasing']);
    expect(order.slice(0, 3)).toEqual(['shop', 'purchasing', 'parts']);
    expect([...order].sort()).toEqual([...all].sort());
  });
  it('brings Money & Books up for a financial focus', () => {
    expect(orderMoreGroups(['financial'])[0]).toBe('money');
  });
});

describe('searchMorePages', () => {
  const items = [
    { title: 'Hitch Kits', sub: 'Labor hours and Curt fitment' },
    { title: 'Estimates', sub: 'Build estimates & push to NetSuite, hitch kits included' },
    { title: 'Settings', sub: 'Password & alerts' },
  ];
  it('matches nothing on an empty search', () => {
    expect(searchMorePages(items, '  ')).toEqual([]);
  });
  it('finds by title or description, title matches first', () => {
    expect(searchMorePages(items, 'HITCH').map(i => i.title)).toEqual(['Hitch Kits', 'Estimates']);
  });
  it('needs every word', () => {
    expect(searchMorePages(items, 'curt labor').map(i => i.title)).toEqual(['Hitch Kits']);
    expect(searchMorePages(items, 'curt password')).toEqual([]);
  });
});
