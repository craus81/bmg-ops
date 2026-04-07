import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * Lightweight NetSuite customer search — returns matching customers by company name.
 * Usage: GET /api/netsuite/customers/search?q=acme
 */
export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get('q')?.trim();
    if (!q || q.length < 2) {
      return NextResponse.json({ results: [], error: 'Search term must be at least 2 characters' });
    }

    // Escape single quotes for SuiteQL
    const safe = q.replace(/'/g, "''");

    const query = `
      SELECT
        c.id,
        c.companyname,
        c.entityid,
        c.email,
        c.phone
      FROM customer c
      WHERE c.isinactive = 'F'
        AND (LOWER(c.companyname) LIKE LOWER('%${safe}%') OR LOWER(c.entityid) LIKE LOWER('%${safe}%'))
      ORDER BY c.companyname
    `;

    const result = await suiteqlQuery(query, 25);
    const items = result?.items || [];

    const results = items.map((c: any) => ({
      id: c.id?.toString(),
      company_name: c.companyname || c.entityid || 'Unknown',
      entity_id: c.entityid || '',
      email: c.email || null,
      phone: c.phone || null,
    }));

    return NextResponse.json({ results });
  } catch (err: any) {
    console.error('NetSuite customer search error:', err);
    return NextResponse.json({ error: err.message || 'Search failed' }, { status: 500 });
  }
}
