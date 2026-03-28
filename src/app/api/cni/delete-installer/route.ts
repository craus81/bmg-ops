import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { userId } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    }

    // 1. Delete internal notes for this installer
    const { error: notesError } = await supabase
      .from('cni_internal_notes')
      .delete()
      .eq('installer_id', userId);

    if (notesError) {
      console.warn('CNI notes delete error:', notesError.message);
    }

    // 2. Delete CNI profile
    const { error: cniError } = await supabase
      .from('cni_profiles')
      .delete()
      .eq('user_id', userId);

    if (cniError) {
      console.warn('CNI profile delete error:', cniError.message);
    }

    // 3. Delete profile record
    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', userId);

    if (profileError) {
      console.error('Profile delete error:', profileError);
    }

    // 4. Delete auth user
    const { error: authError } = await supabase.auth.admin.deleteUser(userId);

    if (authError) {
      return NextResponse.json(
        { error: 'Failed to delete auth user: ' + authError.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('CNI delete installer error:', err);
    return NextResponse.json({ error: err.message || 'Failed to delete installer' }, { status: 500 });
  }
}
