import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { findCustomerDuplicates } from '@/lib/customer-dupes';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const Schema = z.object({
  companyName: z.string().trim().min(1).max(255),
  email: z.string().trim().max(255).optional().nullable(),
  phone: z.string().trim().max(64).optional().nullable(),
  recordType: z.string().trim().max(20).optional().nullable(),
});

/**
 * POST /api/prospects/check-duplicate — the create forms' pre-flight.
 * Server-side so it sees ALL records (the CRM page's old guard matched
 * against the in-memory array + one name ilike; phone/email were never
 * checked anywhere). Read-only; the create paths run the same checker
 * again server-side, so skipping this call can't skip the guard.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  try {
    const matches = await findCustomerDuplicates(service, {
      companyName: p.companyName,
      email: p.email,
      phone: p.phone,
      recordType: p.recordType,
    });
    return NextResponse.json({ matches });
  } catch (e: any) {
    console.error('check-duplicate failed:', e);
    return NextResponse.json({ error: e.message || 'Duplicate check failed' }, { status: 500 });
  }
}
