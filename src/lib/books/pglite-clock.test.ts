// nextMillisecond, which the books' SQL tests wait on so two calls never land
// in the same millisecond of PGlite's clock (see pglite-clock.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { nextMillisecond } from './pglite-clock';

describe('nextMillisecond', () => {
  let pg: PGlite;
  // Starting PGlite takes seconds on a slow machine, so it's not the test's time.
  beforeAll(async () => { pg = new PGlite(); await pg.query('SELECT 1'); }, 60_000);
  afterAll(async () => { await pg.close(); });

  it("makes the next statement's now() later than the last one's, every time", async () => {
    let last = (await pg.query<{ n: string }>('SELECT now()::text AS n')).rows[0].n;
    for (let i = 0; i < 40; i++) {
      await nextMillisecond();
      const { later, n } = (await pg.query<{ later: boolean; n: string }>(
        'SELECT now() > $1::timestamptz AS later, now()::text AS n', [last],
      )).rows[0];
      expect(later, `${n} after ${last}`).toBe(true);
      last = n;
    }
  });
});
