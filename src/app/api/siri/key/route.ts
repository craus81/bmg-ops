import { NextRequest, NextResponse } from 'next/server';
import { requireFeature } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { hashSiriKey, mintSiriKey } from '@/lib/siri-keys';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

/**
 * POST /api/siri/key
 *
 * Mint this iPhone's Siri key (src/lib/siri-keys.ts). The app calls it after
 * sign-in (src/lib/siri-bridge.ts) and stores the key in the Keychain for the
 * Siri intent. The key is returned exactly once; only its hash is kept.
 * Gated on Schedule, the only thing a key can do today.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'schedule');
  if (auth.error) return auth.error;

  const key = mintSiriKey();
  const { data, error } = await createServiceClient()
    .from('siri_keys')
    .insert({ user_id: auth.user.id, key_hash: hashSiriKey(key) })
    .select('id')
    .single();
  if (error || !data) {
    console.error('siri/key mint failed:', error);
    return NextResponse.json({ error: 'Could not create a Siri key' }, { status: 500 });
  }
  return NextResponse.json({ key, keyId: data.id });
}

const RevokeSchema = z.object({ keyId: z.string().uuid() });

/**
 * DELETE /api/siri/key  Body: { keyId }
 *
 * Revoke one of the caller's own keys — the app does this on sign-out, before
 * the session ends. (If the caller has since lost Schedule this 403s, which
 * is harmless: authenticateSiriKey refuses their keys for the same reason.)
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireFeature(req, 'schedule');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, RevokeSchema);
  if (parsed.error) return parsed.error;

  const { error } = await createServiceClient()
    .from('siri_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', parsed.data.keyId)
    .eq('user_id', auth.user.id)
    .is('revoked_at', null);
  if (error) {
    console.error('siri/key revoke failed:', error);
    return NextResponse.json({ error: 'Could not revoke the Siri key' }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
