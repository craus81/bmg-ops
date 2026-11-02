import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import {
  AREAS, OWNER_AREA, OWNER_TABLES, SHOWS, TABLES, parseRowKey, readChanges, readSummary, shownChanges,
  type ChangeArea, type ChangeShow,
} from '@/lib/books/money-changes';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

const OWNER_ONLY = "Only a super admin sees the history of the vendors' bank numbers and the ACH setups and files.";

/**
 * GET /api/admin/books/change-history?show=all|outside|fleetsuite|updates&area=paying&page=0 — Books → Change
 * history (src/lib/books/money-changes.ts, docs/books.md "Change history"): every change to a row of FleetSuite's
 * books, newest first, a page of 50 at a time, each with what it changed from what to what, how it was made and,
 * where FleetSuite knows, who made it; and how many were made in FleetSuite, outside it and by FleetSuite's updates
 * in the last 30 days. &table=<table>&key=<the row's key as JSON> narrows it to one row's history.
 *
 * Super admins, the bookkeeper and the CPA read it (docs/books.md "Who can open the books"); the vendors' bank
 * numbers and the ACH setups and files only super admins, as Pay Vendors shows them. Nothing here changes anything.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;
  const owner = auth.access === 'owner';

  const params = new URL(req.url).searchParams;
  const show = SHOWS.find((s) => s.key === params.get('show'))?.key ?? ('all' as ChangeShow);
  const askedTable = params.get('table');
  const table = askedTable && Object.prototype.hasOwnProperty.call(TABLES, askedTable) ? askedTable : null;
  const key = table ? parseRowKey(params.get('key')) : null;
  const area = table ? null : (AREAS.find((a) => a.key === params.get('area'))?.key ?? null) as ChangeArea | null;
  if (!owner && ((table && OWNER_TABLES.includes(table)) || area === OWNER_AREA)) {
    return NextResponse.json({ error: OWNER_ONLY }, { status: 403 });
  }
  const page = Math.min(Math.max(Number.parseInt(params.get('page') ?? '0', 10) || 0, 0), 1000);
  const service = createServiceClient();
  const now = new Date();
  try {
    const [summary, changes] = await Promise.all([
      readSummary(service, { now, owner }),
      readChanges(service, { show, area, table, key, owner, page }),
    ]);
    return NextResponse.json({
      now: now.toISOString(),
      show,
      area,
      table,
      tableWhat: table ? TABLES[table].what : null,
      key,
      page,
      shows: SHOWS,
      areas: AREAS.filter((a) => owner || a.key !== OWNER_AREA),
      summary,
      changes: await shownChanges(service, changes.rows),
      more: changes.more,
    });
  } catch (err) {
    return failed(err);
  }
}
