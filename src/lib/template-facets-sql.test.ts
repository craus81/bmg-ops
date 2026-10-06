// The wrap estimator's template picker reads roof / bed / cab / body /
// wheelbase from columns that migration 344 generates in the database with
// vehicle_template_facets(), a SQL port of templateFacets(). This runs the
// migration in an in-memory Postgres (PGlite) and holds the port to the
// TypeScript original, plus checks the search / filter functions the picker
// calls.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { templateFacets, type TemplateFacets } from './template-facets';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // The columns of vehicle_templates the migration reads.
  await db.exec(`
    CREATE TABLE vehicle_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year TEXT,
      variant TEXT,
      scale TEXT DEFAULT '1:20',
      template_code TEXT,
      template_image_path TEXT,
      px_per_in NUMERIC,
      overall_length_in NUMERIC,
      overall_height_in NUMERIC,
      wheelbase_in NUMERIC,
      panel_data JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT true
    );
  `);
  const sql = readFileSync(path.resolve(__dirname, '../../migrations/344-vehicle-template-search.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // must be safe to re-run
}, 60_000);

afterAll(async () => { await db?.close(); });

const sqlFacets = async (variant: string | null, name: string | null, wheelbase: number | null): Promise<TemplateFacets> => {
  const r = await db.query<{ f: TemplateFacets }>('SELECT vehicle_template_facets($1, $2, $3) AS f', [variant, name, wheelbase]);
  return r.rows[0].f;
};

// Every description in template-facets.test.ts, plus the shapes the Art
// Station names take.
const KNOWN: [string | null, string | null, number | null][] = [
  ['Passenger Van, 148in, Med Roof, Sliding Door', null, 148],
  ['Cargo Van, 130in, Low Roof, Swing Doors', null, null],
  ['Standard Roof; Cargo; 170in', null, null],
  ['1500 Cargo, Low Roof, 136in', null, null],
  ['Cargo Van, 148in, Extended, High Roof', null, 147.6],
  ['3500, Cargo, High Roof, Extended Body', null, 159],
  ['2500-3500 Cargo, High Roof', null, 159],
  ['Extended Cab Long Box', null, 143.5],
  ['Sedan', null, null],
  ['5 Door Hatchback', null, null],
  ['Wagon SLT', null, null],
  ['Crew Cab Short Bed', null, null],
  ['155in', null, 155.4],
  ["Supercrew 5.5' Box", null, null],
  ['Super Duty Crew Cab Dually 172in', null, null],
  ['Super Duty Super Cab; Short Bed', null, null],
  ["CrewMax 5.5' Standard Bed", null, null],
  ['Single Cab', null, null],
  ['Crewcab', null, null],
  ['Crew Cab Standard Bed', null, null],
  ['HD Double Cab Long Box', null, null],
  ['Super Duty Crew Cab; Flat Bed', null, null],
  ['HD Crew Cab Chassis', null, null],
  ['Extended Cab; Flareside', null, null],
  ['Heavy Duty Crew Cab Reg Bed', null, null],
  ["Crew Cab; 6'4in Box", null, null],
  ['Supercab 8 Box', null, null],
  ['Chassis Cab, 138in, Low Roof', null, null],
  [null, 'Ford Transit 148 High Roof', null],
  ['', 'Ford Transit 148in Super High Roof', null],
  ['   ', 'Ford Transit', null],
  ['Cutaway 16ft Box, 158in', null, null],
  ['Crew Van, 144IN, Mega Roof', null, null],
  ['Convertible', null, null],
  [null, null, null],
  ['Cargo 1500in', null, null],
  ['Dually172in', null, null],
  ['Cargo, 148inch', null, null],
  ['Extended Cab, 141in', null, null],
];

const FRAGMENTS = [
  'Cargo Van', 'Passenger', 'Crew Van', 'Cutaway', 'Chassis Cab', 'Cab Chassis', 'Chassis', 'Sedan', 'Coupe',
  'Wagon', 'Hatchback', 'Roadster', '130in', '148in', '170IN', '1500', '2500-3500', 'Dually 172in', 'Extended',
  'Extended Body', 'EXTENDED', 'Extended Cab', 'High Roof', 'Super High Roof', 'Med Roof', 'Med. Roof',
  'Medium Roof', 'Low Roof', 'Standard Roof', 'Regular Roof', 'Mega Roof', 'Mega Cab', 'SuperCrew',
  'Super Crew', 'CrewMax', 'Super Cab', 'Supercab', 'Crew Cab', 'Crewcab', 'Double Cab', 'Quad Cab',
  'King Cab', 'Access Cab', 'Club Cab', 'Xtra Cab', 'Regular Cab', 'Reg Cab', 'Day Cab', "5.5' Box",
  "6.5' Bed", "8' Long Bed", '16ft Box', "6'4in Box", '8 Box', 'Flat Bed', 'Flatbed', 'Flareside',
  'Short Bed', 'Long Box', 'Standard Bed', 'Reg Bed', 'Regular Box', 'Sliding Door', 'Swing Doors', 'HD', '1500in', 'Dually172in', '148inch',
];

// Deterministic pseudo-random descriptions built from the fragments.
function fuzzCorpus(n: number): [string, null, number | null][] {
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const seps = [', ', ' ', '; '];
  const wheelbases = [null, null, 136, 147.6, 159.5, 0];
  const out: [string, null, number | null][] = [];
  for (let i = 0; i < n; i++) {
    const parts: string[] = [];
    const count = 1 + Math.floor(rand() * 4);
    for (let j = 0; j < count; j++) parts.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]);
    out.push([parts.join(seps[Math.floor(rand() * seps.length)]), null, wheelbases[Math.floor(rand() * wheelbases.length)]]);
  }
  return out;
}

describe('vehicle_template_facets (SQL) matches templateFacets (TS)', () => {
  it('on the known descriptions', async () => {
    for (const [variant, name, wb] of KNOWN) {
      expect(await sqlFacets(variant, name, wb), JSON.stringify([variant, name, wb]))
        .toEqual(templateFacets({ variant, name, wheelbase_in: wb }));
    }
  });

  it('on 3,000 generated descriptions', async () => {
    for (const [variant, name, wb] of fuzzCorpus(3000)) {
      expect(await sqlFacets(variant, name, wb), JSON.stringify([variant, wb]))
        .toEqual(templateFacets({ variant, name, wheelbase_in: wb }));
    }
  }, 60_000);
});

describe('picker search and filters', () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO vehicle_templates (id, name, make, model, year, variant, template_code, template_image_path, wheelbase_in, is_active) VALUES
        ('a', 'Ford Transit - Cargo Van, 148in, High Roof', 'Ford', 'Transit', '2023', 'Cargo Van, 148in, High Roof', 'Transit_23_01', 'x.png', 148, true),
        ('b', 'Ford Transit - Cargo Van, 130in, Low Roof', 'FORD', 'Transit', '2023', 'Cargo Van, 130in, Low Roof', NULL, 'x.png', 130, true),
        ('c', 'Ford F-150 - SuperCrew 5.5'' Box', 'Ford', 'F-150', '2024', 'SuperCrew 5.5'' Box', NULL, 'x.png', NULL, true),
        ('d', 'Ram ProMaster - Cargo, High Roof, Extended', 'Ram', 'ProMaster', '2023', 'Cargo, High Roof, Extended', NULL, 'x.png', 159, true),
        ('e', 'Ford Transit retired', 'Ford', 'Transit', '2019', 'Cargo Van, 148in, Medium Roof', NULL, 'x.png', 148, false),
        ('f', 'Ford Transit no image', 'Ford', 'Transit', '2022', 'Cargo Van', NULL, NULL, NULL, true);
    `);
  });

  const options = async (filters: Record<string, string>) =>
    (await db.query<{ o: Record<string, string[]> }>('SELECT vehicle_template_filter_options($1::jsonb) AS o', [JSON.stringify(filters)])).rows[0].o;
  const search = async (q: string, filters: Record<string, string> = {}, includeRetired = false, limit = 50, offset = 0) =>
    (await db.query<{ r: { total: number; unfiltered_total: number; rows: { id: string; facet_roof: string }[] } }>(
      'SELECT search_vehicle_templates($1, $2::jsonb, $3, $4, $5) AS r', [q, JSON.stringify(filters), limit, offset, includeRetired])).rows[0].r;

  it('narrows each dropdown by the other filters, ignoring case', async () => {
    const all = await options({});
    expect(all.make).toHaveLength(2); // Ford/FORD deduped, plus Ram
    expect(all.year).toEqual(['2023', '2024']); // retired 2019 and imageless 2022 left out
    const ford = await options({ make: 'ford' });
    expect(ford.model).toEqual(['F-150', 'Transit']);
    expect(ford.make).toHaveLength(2); // a dropdown ignores its own value
    const transit = await options({ make: 'Ford', model: 'Transit' });
    expect(transit.roof.sort()).toEqual(['High', 'Low']);
    expect(transit.wheelbase.sort()).toEqual(['130', '148']);
    expect(transit.bed).toEqual([]);
    expect((await options({ make: 'Ram' })).wheelbase).toEqual(['159 Extended']);
  });

  it('matches every search word in any order', async () => {
    expect((await search('high transit')).rows.map(r => r.id)).toEqual(['a']);
    expect((await search('transit_23')).rows.map(r => r.id)).toEqual(['a']);
    expect((await search('  ')).total).toBe(4);
  });

  it('counts what the filters hide', async () => {
    const r = await search('cargo', { make: 'Ram' });
    expect(r.total).toBe(1);
    expect(r.unfiltered_total).toBe(3);
  });

  it('includes retired templates only when asked, and pages', async () => {
    expect((await search('transit')).total).toBe(2);
    expect((await search('transit', {}, true)).total).toBe(3);
    const p2 = await search('', {}, true, 2, 2);
    expect(p2.total).toBe(5);
    expect(p2.rows).toHaveLength(2);
  });

  it('filters by a generated facet', async () => {
    const r = await search('', { roof: 'low' });
    expect(r.rows.map(x => x.id)).toEqual(['b']);
    expect(r.rows[0].facet_roof).toBe('Low');
  });

  it('counts the library', async () => {
    const s = (await db.query<{ s: Record<string, number> }>('SELECT vehicle_template_stats() AS s')).rows[0].s;
    expect(s).toEqual({ total: 5, active: 4, uncalibrated: 5 });
  });
});
