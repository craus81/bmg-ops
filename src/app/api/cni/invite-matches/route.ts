import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { loadCniScorecards } from '@/lib/cni-scorecards';
import {
  rankCompanies, zip5, type CompanyForMatch, type Coord, type JobForMatch,
} from '@/lib/invite-matching';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Ranked invite picker (R6-5). A company's capabilities live on its
 * installers' cni_profiles, so the company view is an aggregate: the union
 * of what its people can do, the widest radius any of them claims, and the
 * best availability on the roster — a company can take the job if anyone
 * there can.
 */

/** Keyword fallback: cni_jobs stores free-text scope, not a typed service. */
function inferServiceType(job: { title?: string | null; scope?: string | null; description?: string | null }): string | null {
  const hay = `${job.title || ''} ${job.scope || ''} ${job.description || ''}`.toLowerCase();
  if (/\b(wrap|decal|graphic|vinyl|lettering)\b/.test(hay)) return 'graphics_install';
  if (/\b(upfit|shelv|rack|partition)\b/.test(hay)) return 'upfitting';
  if (/\b(remov|rebrand|de-?ident)\b/.test(hay)) return 'removal_rebrand';
  if (/\b(camera|gps|telematic|tech|electr)\b/.test(hay)) return 'tech_install';
  return null;
}

const AVAIL_RANK: Record<string, number> = { available: 3, limited: 2, unavailable: 1 };

export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({ jobId: z.string().uuid() }));
  if (q.error) return q.error;

  try {
    const { data: job } = await service
      .from('cni_jobs').select('id, title, scope, description, address').eq('id', q.data.jobId).maybeSingle();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const addr = (job.address || {}) as any;
    const jobForMatch: JobForMatch = {
      zip: addr.zip ? String(addr.zip) : null,
      state: addr.state ? String(addr.state) : null,
      serviceType: inferServiceType(job),
      requiredEquipment: [],
    };

    const [{ data: companies }, { data: members }, scorecards, { data: invites }] = await Promise.all([
      service.from('companies').select('id, name').order('name'),
      service.from('profiles').select('id, company_id').not('company_id', 'is', null),
      loadCniScorecards(service).catch(() => ({ companies: {} as Record<string, any> })),
      service.from('cni_job_invites').select('company_id').eq('job_id', q.data.jobId),
    ]);

    const userIds = (members || []).map((m: any) => m.id);
    const companyByUser = new Map((members || []).map((m: any) => [m.id, m.company_id]));
    const profilesByCompany = new Map<string, any[]>();
    for (let i = 0; i < userIds.length; i += 200) {
      const { data: cnis } = await service
        .from('cni_profiles')
        .select('user_id, business_address, service_area, coverage_radius_miles, service_types, equipment_capabilities, availability_status, risk_tags')
        .in('user_id', userIds.slice(i, i + 200));
      for (const p of cnis || []) {
        const cid = companyByUser.get(p.user_id);
        if (!cid) continue;
        const arr = profilesByCompany.get(cid) || [];
        arr.push(p);
        profilesByCompany.set(cid, arr);
      }
    }

    const forMatch: CompanyForMatch[] = (companies || []).map((c: any) => {
      const profiles = profilesByCompany.get(c.id) || [];
      const addrOf = (p: any) => (p.business_address || {}) as any;
      const card = (scorecards as any).companies?.[c.id];
      return {
        companyId: c.id,
        companyName: c.name,
        zip: profiles.map(p => addrOf(p).zip).find(Boolean) || null,
        state: profiles.map(p => addrOf(p).state).find(Boolean) || null,
        serviceArea: profiles.map(p => p.service_area).find((a: any) => a && a.type) || null,
        coverageRadiusMiles: profiles.reduce<number | null>(
          (max, p) => (p.coverage_radius_miles != null && (max == null || p.coverage_radius_miles > max) ? p.coverage_radius_miles : max), null),
        serviceTypes: [...new Set(profiles.flatMap(p => p.service_types || []))],
        equipmentCapabilities: [...new Set(profiles.flatMap(p => p.equipment_capabilities || []))],
        // A company is as available as its most available installer.
        availabilityStatus: profiles
          .map(p => p.availability_status || 'available')
          .sort((a, b) => (AVAIL_RANK[b] || 0) - (AVAIL_RANK[a] || 0))[0] || null,
        riskTags: [...new Set(profiles.flatMap(p => p.risk_tags || []))],
        onTimeRate: card?.onTimeRate ?? null,
        completions: card?.jobsCompleted ?? 0,
      };
    });

    // Coordinates only when the ZIP table has actually been loaded.
    const wantZips = [...new Set([zip5(jobForMatch.zip), ...forMatch.map(c => zip5(c.zip))].filter(Boolean))];
    const byCompanyId: Record<string, Coord> = {};
    let jobCoord: Coord | null = null;
    let centroidsLoaded = 0;
    if (wantZips.length > 0) {
      const { data: centroids } = await service
        .from('zip_centroids').select('zip, latitude, longitude').in('zip', wantZips);
      centroidsLoaded = (centroids || []).length;
      const coordByZip = new Map((centroids || []).map((z: any) => [z.zip, { latitude: Number(z.latitude), longitude: Number(z.longitude) }]));
      jobCoord = coordByZip.get(zip5(jobForMatch.zip)) || null;
      for (const c of forMatch) {
        const co = coordByZip.get(zip5(c.zip));
        if (co) byCompanyId[c.companyId] = co;
      }
    }

    return NextResponse.json({
      matches: rankCompanies(forMatch, jobForMatch, { job: jobCoord, byCompanyId }),
      invitedIds: (invites || []).map((i: any) => i.company_id).filter(Boolean),
      job: { zip: jobForMatch.zip, state: jobForMatch.state, serviceType: jobForMatch.serviceType },
      // So the UI can say WHY there is no mileage rather than looking broken.
      distanceAvailable: jobCoord != null && Object.keys(byCompanyId).length > 0,
      centroidsLoaded,
    });
  } catch (e: any) {
    console.error('invite matches failed:', e);
    return NextResponse.json({ error: e?.message || 'Ranking failed' }, { status: 500 });
  }
}
