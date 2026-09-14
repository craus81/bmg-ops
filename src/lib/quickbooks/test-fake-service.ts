/**
 * A Supabase stand-in for the ledger tests, in the shape quiet-leads.test.ts
 * proved out: it really applies the filters the query builds, so a test fails
 * when a predicate is dropped rather than merely asserting that a call was
 * made.
 *
 * It is a TEST HELPER that lives in src/ (not a `.test.ts`) because five test
 * files share it. It is imported by those files and by nothing else.
 */

export interface FakeWrite {
  table: string;
  op: 'insert' | 'update' | 'upsert' | 'delete';
  rows: any[];
  filters: [string, any][];
}

export interface FakeService {
  from: (table: string) => any;
  /** Every write, in order — the assertion surface for "what did this run touch?". */
  writes: FakeWrite[];
  /** Rows by table, mutated as writes land. */
  tables: Record<string, any[]>;
  /** Tables whose reads should fail, to test the honest-failure paths. */
  failReadsOn: Set<string>;
}

let idSeq = 0;
const nextId = () => `id-${String(++idSeq).padStart(4, '0')}`;

/** Reset the id sequence so a test's expected ids are stable. */
export function resetFakeIds(): void {
  idSeq = 0;
}

/**
 * PostgREST `.or('a.is.null,a.lt.X')`. Modelled for real rather than waved
 * through: the refresh LEASE is claimed with exactly this filter, and a fake
 * that ignored it would let both concurrent callers "win" — hiding the very
 * race the lease exists to prevent. A term whose operator is not modelled
 * matches, so a permissive `.or()` (the profiles role filter) still behaves.
 */
function orMatches(row: any, expr: string): boolean {
  return expr.split(',').some(term => {
    const first = term.indexOf('.');
    const second = term.indexOf('.', first + 1);
    if (first < 0 || second < 0) return true;
    const col = term.slice(0, first);
    const op = term.slice(first + 1, second);
    const raw = term.slice(second + 1);
    const value = raw === 'null' ? null : raw;
    switch (op) {
      case 'is': return (row[col] ?? null) === value;
      case 'eq': return String(row[col] ?? '') === raw;
      case 'neq': return String(row[col] ?? '') !== raw;
      case 'lt': return row[col] != null && cmp(row[col], value) < 0;
      case 'lte': return row[col] != null && cmp(row[col], value) <= 0;
      case 'gt': return row[col] != null && cmp(row[col], value) > 0;
      case 'gte': return row[col] != null && cmp(row[col], value) >= 0;
      // `roles.cs.{admin}` — array contains. Modelled because the System
      // Health audience is selected with exactly this term, and treating it
      // as "matches everything" would let a non-admin into the audience in
      // a test that is supposed to prove they stay out.
      case 'cs': {
        const wanted = raw.replace(/^\{|\}$/g, '').split(',').map(x => x.trim()).filter(Boolean);
        const have = Array.isArray(row[col]) ? row[col].map(String) : [];
        return wanted.every(w => have.includes(w));
      }
      default: return true;
    }
  });
}

const cmp = (a: any, b: any) => {
  const x = a ?? '';
  const y = b ?? '';
  if (x === y) return 0;
  return String(x) < String(y) ? -1 : 1;
};

export function makeFakeService(seed: Record<string, any[]> = {}): FakeService {
  const tables: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }));
  const writes: FakeWrite[] = [];
  const failReadsOn = new Set<string>();

  const from = (table: string) => {
    tables[table] ||= [];
    const filters: [string, any][] = [];
    const orders: [string, number][] = [];
    let selection: string | null = null;
    let headCount = false;
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let pending: { op: FakeWrite['op']; rows: any[] } | null = null;
    let singleMode: 'maybe' | 'single' | null = null;

    const matches = (row: any) =>
      filters.every(([kind, arg]) => {
        const [col, value] = arg;
        switch (kind) {
          case 'eq': return row[col] === value;
          case 'neq': return row[col] !== value;
          case 'gt': return cmp(row[col], value) > 0;
          case 'gte': return cmp(row[col], value) >= 0;
          case 'lt': return cmp(row[col], value) < 0;
          case 'lte': return cmp(row[col], value) <= 0;
          case 'is': return (row[col] ?? null) === value;
          case 'not': return (row[col] ?? null) !== value;
          case 'in': return (value as any[]).includes(row[col]);
          case 'ilike': {
            const pattern = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
            return new RegExp(`^${pattern}$`, 'i').test(String(row[col] ?? ''));
          }
          case 'like': {
            const pattern = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
            return new RegExp(`^${pattern}$`).test(String(row[col] ?? ''));
          }
          case 'or': return orMatches(row, String(value));
          default: return true;
        }
      });

    const selected = () => {
      let rows = tables[table].filter(matches);
      if (orders.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const [col, dir] of orders) {
            const c = cmp(a[col], b[col]);
            if (c !== 0) return c * dir;
          }
          return 0;
        });
      }
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit != null) rows = rows.slice(0, limit);
      return rows;
    };

    const settle = (): any => {
      if (failReadsOn.has(table) && !pending) {
        return { data: null, error: { message: `read failed on ${table}` }, count: null };
      }
      if (pending) {
        const { op, rows } = pending;
        const touched: any[] = [];
        if (op === 'insert' || op === 'upsert') {
          for (const row of rows) {
            const key = row.external_id != null && row.source != null
              ? (r: any) => r.source === row.source && r.external_id === row.external_id
              : row.id != null
                ? (r: any) => r.id === row.id
                : row.sync_type != null
                  ? (r: any) => r.sync_type === row.sync_type
                  : row.key != null
                    ? (r: any) => r.key === row.key
                    : () => false;
            const existing = op === 'upsert' ? tables[table].find(key) : undefined;
            if (existing) {
              Object.assign(existing, row);
              touched.push(existing);
            } else {
              const created = { id: row.id ?? nextId(), ...row };
              tables[table].push(created);
              touched.push(created);
            }
          }
        } else if (op === 'update') {
          for (const row of tables[table].filter(matches)) {
            Object.assign(row, rows[0]);
            touched.push(row);
          }
        } else if (op === 'delete') {
          const keep = tables[table].filter(r => !matches(r));
          touched.push(...tables[table].filter(matches));
          tables[table] = keep;
        }
        writes.push({ table, op, rows: rows.map(r => ({ ...r })), filters: filters.map(f => f[1]) as any });
        pending = null;
        if (!selection) return { data: null, error: null };
        if (singleMode) return { data: touched[0] ?? null, error: null };
        return { data: touched, error: null };
      }
      const rows = selected();
      if (headCount) return { data: null, error: null, count: rows.length };
      if (singleMode === 'single' && rows.length !== 1) {
        return { data: null, error: { message: 'expected exactly one row' } };
      }
      if (singleMode) return { data: rows[0] ?? null, error: null };
      return { data: rows.map(r => ({ ...r })), error: null, count: rows.length };
    };

    const q: any = {
      select: (sel?: string, opts?: { count?: string; head?: boolean }) => {
        selection = sel ?? '*';
        if (opts?.head) headCount = true;
        return q;
      },
      insert: (rows: any) => { pending = { op: 'insert', rows: Array.isArray(rows) ? rows : [rows] }; return q; },
      upsert: (rows: any) => { pending = { op: 'upsert', rows: Array.isArray(rows) ? rows : [rows] }; return q; },
      update: (row: any) => { pending = { op: 'update', rows: [row] }; return q; },
      delete: () => { pending = { op: 'delete', rows: [] }; return q; },
      eq: (c: string, v: any) => { filters.push(['eq', [c, v]]); return q; },
      neq: (c: string, v: any) => { filters.push(['neq', [c, v]]); return q; },
      gt: (c: string, v: any) => { filters.push(['gt', [c, v]]); return q; },
      gte: (c: string, v: any) => { filters.push(['gte', [c, v]]); return q; },
      lt: (c: string, v: any) => { filters.push(['lt', [c, v]]); return q; },
      lte: (c: string, v: any) => { filters.push(['lte', [c, v]]); return q; },
      is: (c: string, v: any) => { filters.push(['is', [c, v]]); return q; },
      not: (c: string, _op: string, v: any) => { filters.push(['not', [c, v]]); return q; },
      in: (c: string, v: any[]) => { filters.push(['in', [c, v]]); return q; },
      ilike: (c: string, v: string) => { filters.push(['ilike', [c, v]]); return q; },
      like: (c: string, v: string) => { filters.push(['like', [c, v]]); return q; },
      or: (v: string) => { filters.push(['or', [null, v]]); return q; },
      order: (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending === false ? -1 : 1]); return q; },
      limit: (n: number) => { limit = n; return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      maybeSingle: () => { singleMode = 'maybe'; return Promise.resolve(settle()); },
      single: () => { singleMode = 'single'; return Promise.resolve(settle()); },
      then: (res: any, rej?: any) => Promise.resolve(settle()).then(res, rej),
    };
    return q;
  };

  return { from, writes, tables, failReadsOn } as FakeService;
}

/** Every write against one table, for "did this run touch it at all?" checks. */
export function writesTo(service: FakeService, table: string): FakeWrite[] {
  return service.writes.filter(w => w.table === table);
}
