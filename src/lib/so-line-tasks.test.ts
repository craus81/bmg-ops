import { describe, it, expect } from 'vitest';
import {
  buildSoLineTasks, summarizeTaskHours, hoursNote, taskLabel, buildSoTaskRows,
  type SoTaskLine, type TaskCatalogEntry,
} from './so-line-tasks';

const cat = (over: Partial<TaskCatalogEntry> & { item_number: string }): [string, TaskCatalogEntry] =>
  [over.item_number, { item_type: 'INVTPART', ...over }];

const CATALOG = new Map<string, TaskCatalogEntry>([
  cat({ item_number: 'AS-4200', display_name: 'Steel shelving unit', labor_hours: 1.5, image_path: 'photos/as4200.jpg' }),
  cat({ item_number: 'LR-100', display_name: 'Ladder rack', labor_hours: 0 }),
  cat({ item_number: 'NP-9', display_name: 'Unpriced bracket', labor_hours: null }),
  cat({ item_number: 'LABOR', display_name: 'Shop labor', item_type: 'SERVICE', labor_hours: null }),
]);

const line = (item: string, qty: number | null = 1, description: string | null = null): SoTaskLine =>
  ({ item_number: item, quantity: qty, description });

describe('buildSoLineTasks', () => {
  it('makes one task per part with quantity, hours and photo', () => {
    const tasks = buildSoLineTasks([line('AS-4200', 2)], CATALOG);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      itemNumber: 'AS-4200',
      label: '2× AS-4200 — Steel shelving unit',
      quantity: 2,
      expectedHours: 3,          // 1.5h each
      imagePath: 'photos/as4200.jpg',
      inCatalog: true,
    });
  });

  it('sums duplicate lines instead of listing a part twice', () => {
    // Two half-checked rows for one bracket is how a checklist stops
    // being trusted.
    const tasks = buildSoLineTasks([line('AS-4200', 2), line('AS-4200', 3)], CATALOG);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].quantity).toBe(5);
    expect(tasks[0].expectedHours).toBe(7.5);
  });

  it('drops service and labor lines — nobody installs those', () => {
    const tasks = buildSoLineTasks([line('LABOR', 8), line('AS-4200')], CATALOG);
    expect(tasks.map(t => t.itemNumber)).toEqual(['AS-4200']);
  });

  it('drops the FS-CUSTOM placeholder', () => {
    expect(buildSoLineTasks([line('FS-CUSTOM', 1)], CATALOG)).toHaveLength(0);
  });

  it('keeps a part the catalog has never heard of, and says so', () => {
    // The customer bought it, so it belongs on the wall — unenriched
    // beats silently absent.
    const tasks = buildSoLineTasks([line('MYSTERY-1', 2, 'Custom bracket')], CATALOG);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].inCatalog).toBe(false);
    expect(tasks[0].label).toBe('2× MYSTERY-1 — Custom bracket');
    expect(tasks[0].expectedHours).toBeNull();
  });

  it('keeps 0 hours and unknown hours apart', () => {
    const tasks = buildSoLineTasks([line('LR-100'), line('NP-9')], CATALOG);
    const byItem = Object.fromEntries(tasks.map(t => [t.itemNumber, t.expectedHours]));
    expect(byItem['LR-100']).toBe(0);      // deliberately no labor charged
    expect(byItem['NP-9']).toBeNull();     // nobody has priced it
  });

  it('treats a missing or bad quantity as one unit rather than zero', () => {
    const tasks = buildSoLineTasks([line('AS-4200', null)], CATALOG);
    expect(tasks[0].quantity).toBe(1);
  });
});

describe('taskLabel', () => {
  it('leaves the multiplier off a single unit', () => {
    expect(taskLabel('AS-4200', 'Shelving', 1)).toBe('AS-4200 — Shelving');
  });
  it('survives a part with no name at all', () => {
    expect(taskLabel('AS-4200', null, 3)).toBe('3× AS-4200');
  });
});

describe('summarizeTaskHours / hoursNote', () => {
  it('sums only priced parts and counts what it left out', () => {
    const tasks = buildSoLineTasks([line('AS-4200', 2), line('NP-9')], CATALOG);
    const s = summarizeTaskHours(tasks);
    expect(s).toMatchObject({ hours: 3, priced: 1, unpriced: 1, total: 2 });
    expect(hoursNote(s)).toBe('3h across 1 part · 1 unpriced');
  });

  it('never states a total when nothing is priced', () => {
    const tasks = buildSoLineTasks([line('NP-9')], CATALOG);
    expect(hoursNote(summarizeTaskHours(tasks))).toBe('1 part · no labor priced yet');
  });

  it('says nothing when there are no parts', () => {
    expect(hoursNote(summarizeTaskHours([]))).toBe('');
  });
});

describe('buildSoTaskRows', () => {
  it('never marks an SO-line task required', () => {
    // The completion gate blocks on required tasks. A mirror that dropped
    // a line must not be able to strand a finished vehicle.
    const tasks = buildSoLineTasks([line('AS-4200'), line('NP-9')], CATALOG);
    const rows = buildSoTaskRows(tasks, 'veh-1', 5);
    expect(rows.every(r => r.required === false)).toBe(true);
    expect(rows.every(r => r.source === 'so_line')).toBe(true);
    expect(rows.map(r => r.sort_order)).toEqual([5, 6]);
  });
});
