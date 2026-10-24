import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  normalizeFocus, resolveDashboardFocus, splitTodos, dashboardCards, TODO_AREA,
} from './dashboard-focus';

const roles = (r: Partial<{ isAdmin: boolean; sales: boolean; finance: boolean; executive: boolean }> = {}) =>
  ({ isAdmin: false, sales: false, finance: false, executive: false, ...r });

describe('normalizeFocus', () => {
  it('keeps known values once, in a fixed order', () => {
    expect(normalizeFocus(['purchasing', 'scheduling', 'purchasing', 'bogus'])).toEqual(['scheduling', 'purchasing']);
  });
  it('lets everything stand alone', () => {
    expect(normalizeFocus(['sales', 'everything'])).toEqual(['everything']);
  });
  it('treats empty or junk as no pick', () => {
    expect(normalizeFocus([])).toBeNull();
    expect(normalizeFocus(null)).toBeNull();
    expect(normalizeFocus('sales')).toBeNull();
  });
});

describe('resolveDashboardFocus', () => {
  it('uses the saved pick over the role', () => {
    expect(resolveDashboardFocus(['sales'], roles({ isAdmin: true }))).toEqual(['sales']);
  });
  it('falls back to the role', () => {
    expect(resolveDashboardFocus(null, roles({ isAdmin: true, sales: true }))).toEqual(['everything']);
    expect(resolveDashboardFocus(null, roles({ sales: true }))).toEqual(['sales']);
    expect(resolveDashboardFocus(null, roles({ executive: true }))).toEqual(['financial']);
    expect(resolveDashboardFocus(null, roles())).toEqual(['everything']);
  });
});

describe('splitTodos', () => {
  const items = Object.keys(TODO_AREA).map(key => ({ key }));
  const keys = (xs: { key: string }[]) => xs.map(x => x.key).sort();

  it('gives a scheduling + purchasing person only those to-dos', () => {
    const { mine } = splitTodos(items, ['scheduling', 'purchasing']);
    expect(keys(mine)).toEqual(['imports', 'parts-requested', 'promised-back', 'ready-pickup', 'waitingpo']);
  });
  it('gives a sales person only sales to-dos', () => {
    expect(keys(splitTodos(items, ['sales']).mine)).toEqual(['atrisk', 'proofs', 'quiet-leads', 'quotes']);
  });
  it('gives Everything the owner and money items first, the rest of the shop after', () => {
    const { mine, others } = splitTodos(items, ['everything']);
    expect(keys(mine)).toEqual(['ap', 'flagged', 'health', 'invoice', 'never-invoiced', 'unpaid', 'unpriced', 'users']);
    expect(mine.length + others.length).toBe(items.length);
  });
});

describe('dashboardCards', () => {
  it('opens a card if any picked focus opens it', () => {
    const c = dashboardCards(['scheduling', 'purchasing']);
    expect(c.next7).toBe('open');
    expect(c.shopLoad).toBe('open');
    expect(c.openPos).toBe('folded');
    expect(c.kpis).toBeUndefined();
  });
  it('keeps the Financial focus to its one card', () => {
    expect(dashboardCards(['financial'])).toEqual({ finance: 'open' });
  });
  it('shows a sales focus no money tiles or shop cards', () => {
    const c = dashboardCards(['sales']);
    expect(c.kpis).toBeUndefined();
    expect(c.graphics).toBeUndefined();
    expect(c.sales).toBe('folded');
  });
});

describe('Dashboard to-do keys', () => {
  it('every to-do the Dashboard raises has an area', () => {
    const src = readFileSync(join(__dirname, '../components/OpsDashboard.tsx'), 'utf8');
    const raised = [...src.matchAll(/key: '([a-z-]+)', count:/g)].map(m => m[1]);
    expect(raised.length).toBeGreaterThan(10);
    for (const k of raised) expect(Object.keys(TODO_AREA)).toContain(k);
  });
});
