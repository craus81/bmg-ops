import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { findOrMirrorPart } from '@/lib/parts-mirror';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  partNumber: z.string().trim().min(2).max(80),
});

/**
 * "Is this part real?" resolver for typeaheads: local catalog first, then
 * NetSuite — mirroring a NetSuite-found item into netsuite_parts so it's
 * never flagged as unknown again.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const result = await findOrMirrorPart(service, parsed.data.partNumber);
  return NextResponse.json({
    found: !!result.part && result.part.is_active !== false,
    part: result.part,
    mirrored: result.mirrored,
    ...(result.error ? { error: result.error } : {}),
  });
}
