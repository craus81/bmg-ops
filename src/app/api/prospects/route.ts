import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ProspectFields = {
  company_name: z.string().trim().max(200),
  contact_name: z.string().max(120).optional().nullable(),
  title: z.string().max(120).optional().nullable(),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  state: z.string().max(40).optional().nullable(),
  zip: z.string().max(20).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  source: z.string().max(40).optional(),
  created_by: z.string().uuid().optional().nullable(),
} as const;

const CreateProspectSchema = z.object(ProspectFields);
const UpdateProspectSchema = z
  .object({
    id: z.string().uuid(),
    company_name: z.string().trim().max(200).optional(),
    contact_name: ProspectFields.contact_name,
    title: ProspectFields.title,
    email: ProspectFields.email,
    phone: ProspectFields.phone,
    address: ProspectFields.address,
    city: ProspectFields.city,
    state: ProspectFields.state,
    zip: ProspectFields.zip,
    website: ProspectFields.website,
    notes: ProspectFields.notes,
    source: ProspectFields.source,
    created_by: ProspectFields.created_by,
    netsuite_id: z.string().max(40).optional().nullable(),
  })
  .passthrough();

/** GET /api/prospects — list all prospects */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ prospects: data });
}

/** POST /api/prospects — create a new prospect */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateProspectSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const { data, error } = await supabase
    .from('prospects')
    .insert({
      company_name: body.company_name,
      contact_name: body.contact_name || null,
      title: body.title || null,
      email: body.email || null,
      phone: body.phone || null,
      address: body.address || null,
      city: body.city || null,
      state: body.state || null,
      zip: body.zip || null,
      website: body.website || null,
      notes: body.notes || null,
      source: body.source || 'manual',
      created_by: body.created_by || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, prospect: data });
}

/** PUT /api/prospects — update a prospect */
export async function PUT(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateProspectSchema);
  if (parsed.error) return parsed.error;
  const { id, ...fields } = parsed.data;

  const { data, error } = await supabase
    .from('prospects')
    .update(fields)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, prospect: data });
}

/** DELETE /api/prospects — delete a prospect */
export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await supabase.from('prospects').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
