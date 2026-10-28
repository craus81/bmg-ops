import { describe, it, expect, vi, beforeEach } from 'vitest';

const notifyMany = vi.fn(async (..._args: any[]) => {});
vi.mock('./notify', () => ({ notifyMany: (...args: any[]) => notifyMany(...args) }));
vi.mock('./install-scheduling', () => ({ installSchedulerIds: async () => ['jessie'] }));
vi.mock('./parts-readiness', () => ({ computePartsReadinessBoard: async () => ({}) }));

import { syncJobScheduleAlert } from './job-schedule-alerts';

/** A tiny upfit_projects stand-in: one row, conditional updates honored. */
function fakeService(initialStep: string | null) {
  const row: any = { schedule_alert_step: initialStep };
  const service: any = {
    row,
    from: (table: string) => {
      if (table === 'notification_preferences') {
        return { select: () => ({ eq: async () => ({ data: [{ user_id: 'craig' }] }) }) };
      }
      let patch: any = null;
      let guardOk = true;
      const q: any = {
        update: (p: any) => { patch = p; return q; },
        eq: (col: string, val: any) => { if (col === 'schedule_alert_step' && row.schedule_alert_step !== val) guardOk = false; return q; },
        or: (expr: string) => {
          const step = expr.split('neq.')[1];
          if (row.schedule_alert_step === step) guardOk = false;
          return q;
        },
        select: async () => {
          if (guardOk) Object.assign(row, patch);
          return { data: guardOk ? [{ id: 'p1' }] : [] };
        },
        then: (resolve: any) => { if (guardOk && patch) Object.assign(row, patch); resolve({ error: null }); },
      };
      return q;
    },
  };
  return service;
}

const project = (step: string | null, extra: Record<string, any> = {}) => ({
  id: 'p1', project_name: 'Hosemate van', customer_name: 'Hosemate', status: 'sold',
  netsuite_so_id: '1', netsuite_so_number: 'SO1167', customer_dropoff_date: null,
  schedule_alert_step: step, ...extra,
});

beforeEach(() => notifyMany.mockClear());

describe('syncJobScheduleAlert', () => {
  it('tells Jessie and Craig to reserve when parts are in stock', async () => {
    const svc = fakeService(null);
    expect(await syncJobScheduleAlert(svc, project(null), 'ready')).toBe('reserve');
    expect(notifyMany).toHaveBeenCalledTimes(1);
    const [ids, payload] = notifyMany.mock.calls[0] as any[];
    expect(ids.sort()).toEqual(['craig', 'jessie']);
    expect(payload.type).toBe('job_reserve_parts');
    expect(payload.url).toContain('focus=parts');
    expect(svc.row.schedule_alert_step).toBe('reserve');
  });

  it('sends the schedule alert once every part is reserved', async () => {
    const svc = fakeService('reserve');
    expect(await syncJobScheduleAlert(svc, project('reserve'), 'reserved')).toBe('schedule');
    const payload = (notifyMany.mock.calls[0] as any[])[1];
    expect(payload.type).toBe('job_ready_to_schedule');
    expect(payload.body).toContain('Call Hosemate');
    expect(payload.url).toContain('focus=dates');
  });

  it('does not repeat a step already sent', async () => {
    const svc = fakeService('schedule');
    expect(await syncJobScheduleAlert(svc, project('schedule'), 'reserved')).toBeNull();
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it('does not send when another run already claimed the step', async () => {
    const svc = fakeService('schedule');
    expect(await syncJobScheduleAlert(svc, project('reserve'), 'reserved')).toBeNull();
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it('clears the step once the drop-off date is set, so it can alert again later', async () => {
    const svc = fakeService('schedule');
    await syncJobScheduleAlert(svc, project('schedule', { customer_dropoff_date: '2026-11-02' }), 'reserved');
    expect(svc.row.schedule_alert_step).toBeNull();
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it('keeps the step when the job could not be judged', async () => {
    const svc = fakeService('reserve');
    await syncJobScheduleAlert(svc, project('reserve'), undefined);
    expect(svc.row.schedule_alert_step).toBe('reserve');
  });

  it('only sends "schedule" from the job page, never "reserve"', async () => {
    const svc = fakeService(null);
    expect(await syncJobScheduleAlert(svc, project(null), 'ready', { only: 'schedule' })).toBeNull();
    expect(notifyMany).not.toHaveBeenCalled();
  });
});
