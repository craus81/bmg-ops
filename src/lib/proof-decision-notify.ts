import { notifyMany, notifyDecisionWatchers, type NotifyPayload } from './notify';

/**
 * A customer's answer on a graphics proof. The job's own people (whoever
 * entered it, the person assigned, whoever sent the proof) always hear on
 * every channel, email included: staff asked where approvals go and found
 * only the bell (Craig, 2026-10-20). Everyone else in `targetIds` (admins
 * and production) gets it the way their Settings say, and anyone who opted
 * in to every customer decision gets a copy.
 */
export async function notifyProofDecision(
  job: { created_by?: string | null; assigned_to?: string | null; sent_for_approval_by?: string | null },
  targetIds: Iterable<string>,
  payload: Omit<NotifyPayload, 'userId' | 'channels' | 'forceChannels'>,
): Promise<void> {
  const onJob = new Set([job.created_by, job.assigned_to, job.sent_for_approval_by].filter((id): id is string => !!id));
  const everyone = new Set(targetIds);
  onJob.forEach(id => everyone.add(id));
  const team = Array.from(everyone).filter(id => !onJob.has(id));

  await Promise.allSettled([
    notifyMany(Array.from(onJob), { ...payload, channels: ['in_app', 'push', 'email'], forceChannels: true }),
    notifyMany(team, payload),
  ]);
  const { type: _type, ...rest } = payload;
  await notifyDecisionWatchers(everyone, rest);
}
