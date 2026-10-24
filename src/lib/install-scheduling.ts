/**
 * From customer approval to install confirmation (Valarie's process note,
 * 2026-10-23; Craig's picks 2026-10-24, thread "Notify production and
 * scheduling on approval").
 *
 *   Estimate approved → graphics team: "Start designing"
 *   Proof approved    → Brian: "ready to produce" (proof-decision-notify)
 *                     → whoever schedules installs: "Schedule install"
 *   Date set          → staff press "Send install confirmation" (client + rep)
 *
 * An estimate approved together with its proof skips "Start designing":
 * the art is already approved, so the proof_approved message stands alone.
 *
 * Who schedules installs is an audience opt-in,
 * notification_preferences.schedules_installs (migration 430), ticked for
 * Jessie only at first. Only jobs that get installed (onsite or at our
 * shop) need a date; shipped and picked-up work skips the step.
 *
 * Nothing here emails a customer: the confirmation is built here but only
 * ever sent from the job page's compose screen (CLAUDE.md "No customer
 * email sends itself").
 */
import { notifyMany } from './notify';
import { deepLinks } from './deep-links';
import { LEGAL } from './legal';
import { buildCalendar, icsDate } from './ics';
import { INSTALLED_DELIVERY_METHODS, DONE_STATUSES, isInstalledJob, longDate, needsInstallDate } from './install-scheduling-state';

export { INSTALLED_DELIVERY_METHODS, isInstalledJob, longDate, needsInstallDate };

// Structural, so callers holding a narrowed client type (proof-rep-review) fit too.
type Db = { from: (table: string) => any };

/** Everyone ticked "Schedules installs". */
export async function installSchedulerIds(service: Db): Promise<string[]> {
  const { data } = await service
    .from('notification_preferences')
    .select('user_id')
    .eq('schedules_installs', true);
  const ids: string[] = ((data || []) as any[]).map(r => r.user_id as string).filter(Boolean);
  return [...new Set(ids)];
}

/** Whether this person has the "Schedules installs" tick. */
export async function isInstallScheduler(service: Db, userId: string): Promise<boolean> {
  const { data } = await service
    .from('notification_preferences')
    .select('schedules_installs')
    .eq('user_id', userId)
    .maybeSingle();
  return !!data?.schedules_installs;
}

/** Graphics production people: Brian today. Approved accounts only. */
export async function graphicsTeamIds(service: Db): Promise<string[]> {
  const { data } = await service
    .from('profiles')
    .select('id')
    .or('role.in.(graphics_production,production),roles.cs.{graphics_production}')
    .eq('status', 'approved');
  return (data || []).map((p: any) => p.id as string);
}

const jobLabel = (job: any) => job.title || (job.job_number ? `Job #${job.job_number}` : 'Graphics job');

/**
 * The customer approved this job's proof (link, combined estimate, or a
 * rep's verbal OK): tell whoever schedules installs to call the client.
 * Best-effort; the approval already stands.
 */
export async function notifyInstallSchedulers(
  service: Db,
  jobId: string,
  opts: { actorId?: string | null } = {},
): Promise<void> {
  try {
    const { data: job } = await service
      .from('graphics_jobs')
      .select('id, job_number, title, customer, status, delivery_method, scheduled_install_date, assigned_to, estimate_id, customer_approved')
      .eq('id', jobId)
      .maybeSingle();
    if (!job || !needsInstallDate(job)) return;

    const ids = (await installSchedulerIds(service)).filter(id => id !== opts.actorId);
    if (ids.length === 0) return;

    const [producer, rep] = await Promise.all([
      job.assigned_to ? nameOf(service, job.assigned_to) : Promise.resolve(null),
      repForJob(service, job).then(r => r?.name || null),
    ]);
    const where = job.delivery_method === 'bmg_shop' ? 'at our shop' : 'at their site';
    const parts = [
      `${job.customer || 'The customer'} approved the proof.`,
      producer ? `${producer} has it for production.` : 'It is ready for production.',
      `Call the client to set an install date (${where}).`,
      rep ? `Rep: ${rep}.` : '',
    ].filter(Boolean);

    await notifyMany(ids, {
      type: 'graphics_schedule_install',
      title: `Schedule install: ${jobLabel(job)}`,
      body: parts.join(' '),
      url: deepLinks.graphicsJob(job.id, { schedule: true }),
    });
  } catch (err) {
    console.error('schedule-install notification failed:', err);
  }
}

/**
 * The customer approved an estimate. Graphics jobs on it whose proof is
 * not approved yet need designing; an estimate with graphics on it and no
 * job yet needs one made. Jobs approved together with this estimate
 * (`approvedJobIds`) already got "ready to produce" and are skipped.
 */
export async function notifyStartDesigning(
  service: Db,
  estimate: { id: string; estimate_number?: string | null; title?: string | null; customer_name?: string | null; fleet_group_id?: string | null },
  approvedJobIds: Set<string>,
): Promise<void> {
  try {
    const filter = estimate.fleet_group_id
      ? `estimate_id.eq.${estimate.id},fleet_group_id.eq.${estimate.fleet_group_id}`
      : `estimate_id.eq.${estimate.id}`;
    const { data: jobs } = await service
      .from('graphics_jobs')
      .select('id, job_number, title, customer, status, assigned_to, customer_approved')
      .or(filter);
    const linked = (jobs || []) as any[];
    const team = await graphicsTeamIds(service);
    const customer = estimate.customer_name || 'The customer';
    const est = `Estimate #${estimate.estimate_number || ''}${estimate.title ? ` (${estimate.title})` : ''}`;

    const toDesign = linked.filter(j =>
      !approvedJobIds.has(j.id) && !j.customer_approved && !DONE_STATUSES.includes(j.status));
    for (const job of toDesign) {
      const ids = [...new Set([...(job.assigned_to ? [job.assigned_to] : []), ...team])];
      if (ids.length === 0) continue;
      await notifyMany(ids, {
        type: 'graphics_start_designing',
        title: `Start designing: ${jobLabel(job)}`,
        body: `${customer} approved ${est}. Design the proof and send it for approval.`,
        url: deepLinks.graphicsJob(job.id),
      });
    }

    // Graphics on the estimate but no job anywhere: make one.
    if (linked.length === 0 && team.length > 0 && await estimateHasGraphics(service, estimate.id)) {
      await notifyMany(team, {
        type: 'graphics_start_designing',
        title: `Start designing: ${estimate.customer_name || est}`,
        body: `${customer} approved ${est}, which has graphics on it and no graphics job yet. Create the job, then design the proof.`,
        url: deepLinks.graphicsNewFromEstimate(estimate.id),
      });
    }
  } catch (err) {
    console.error('start-designing notification failed:', err);
  }
}

/** Graphics-catalog lines or a folded wrap quote. */
async function estimateHasGraphics(service: Db, estimateId: string): Promise<boolean> {
  const { count: quotes } = await service
    .from('wrap_quotes')
    .select('id', { count: 'exact', head: true })
    .eq('estimate_id', estimateId);
  if ((quotes || 0) > 0) return true;
  const { data: lines } = await service
    .from('estimate_line_items')
    .select('part_id')
    .eq('estimate_id', estimateId)
    .not('part_id', 'is', null);
  const partIds = [...new Set((lines || []).map((l: any) => l.part_id as string))];
  if (partIds.length === 0) return false;
  const { count } = await service
    .from('netsuite_parts')
    .select('id', { count: 'exact', head: true })
    .in('id', partIds)
    .eq('catalog', 'graphics');
  return (count || 0) > 0;
}

async function nameOf(service: Db, userId: string): Promise<string | null> {
  const { data } = await service.from('profiles').select('full_name').eq('id', userId).maybeSingle();
  return data?.full_name || null;
}

/**
 * The sales rep on a job: the customer's account owner, else whoever wrote
 * the estimate, else whoever entered the job. Same order the approval
 * alerts use for "the rep".
 */
export async function repForJob(
  service: Db,
  job: { estimate_id?: string | null; created_by?: string | null },
): Promise<{ id: string; name: string | null; email: string | null } | null> {
  let repId: string | null = null;
  if (job.estimate_id) {
    const { data: est } = await service
      .from('estimates')
      .select('created_by, customer_id')
      .eq('id', job.estimate_id)
      .maybeSingle();
    if (est?.customer_id) {
      const { data: cust } = await service
        .from('customers')
        .select('account_owner_id')
        .eq('id', est.customer_id)
        .maybeSingle();
      repId = cust?.account_owner_id || null;
    }
    repId = repId || est?.created_by || null;
  }
  repId = repId || job.created_by || null;
  if (!repId) return null;
  const { data } = await service.from('profiles').select('id, full_name, email').eq('id', repId).maybeSingle();
  return data ? { id: data.id, name: data.full_name || null, email: data.email || null } : null;
}

// ─── The confirmation email ───────────────────────────────────────

export interface InstallConfirmationJob {
  id: string;
  title?: string | null;
  job_number?: string | null;
  customer?: string | null;
  delivery_method?: string | null;
  ship_to?: string | null;
  scheduled_install_date?: string | null;
  install_arrival_time?: string | null;
  delivery_contact_name?: string | null;
  delivery_contact_phone?: string | null;
}

/** Where the install happens, as the customer should read it. */
export function installPlace(job: InstallConfirmationJob): string {
  if (job.delivery_method === 'bmg_shop') return `BMG Fleet shop, ${LEGAL.address}`;
  const site = (job.ship_to || '').replace(/\s*\n\s*/g, ', ').trim();
  return site || 'Your site';
}

const shortDate = (ymd: string) => {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
};

/** Subject, heading, body text, a Google Calendar link and a .ics file. */
export function buildInstallConfirmation(job: InstallConfirmationJob, appUrl: string) {
  const date = (job.scheduled_install_date || '').slice(0, 10);
  const time = (job.install_arrival_time || '').trim();
  const what = job.title || (job.job_number ? `Job #${job.job_number}` : 'your graphics');
  const place = installPlace(job);
  const onShop = job.delivery_method === 'bmg_shop';

  const subject = `Install confirmed: ${shortDate(date)}${time ? ` at ${time}` : ''}, ${what}`;
  const title = `Your install is booked: ${what}`;
  const body = [
    `${longDate(date)}${time ? `, ${onShop ? 'drop-off' : 'arrival'} ${time}` : ''}.`,
    `Location: ${place}.`,
    onShop
      ? 'Please bring the vehicle to our shop at that time.'
      : 'Our installer will meet you there. Please have the vehicle clean and available.',
    'Reply to this email if anything needs to change.',
  ].join(' ');

  const summary = `BMG Fleet install: ${what}`;
  const details = `${what}${time ? `\nArrival: ${time}` : ''}\n${place}`;
  const next = nextDay(date);
  const googleUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(summary)}`
    + `&dates=${icsDate(date)}/${icsDate(next)}`
    + `&details=${encodeURIComponent(details)}`
    + `&location=${encodeURIComponent(place)}`;

  const ics = buildCalendar([{
    uid: `install-${job.id}@bmgfleet.com`,
    start: date,
    end: date,
    summary,
    description: details,
    location: place,
    status: 'CONFIRMED',
  }], { name: 'BMG Fleet install' });

  return {
    subject,
    title,
    body,
    googleUrl,
    ics: { filename: 'install.ics', content: Buffer.from(ics, 'utf-8'), contentType: 'text/calendar' },
    appLink: `${appUrl.replace(/\/$/, '')}${deepLinks.graphicsJob(job.id)}`,
  };
}

function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
