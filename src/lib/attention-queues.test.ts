import { describe, it, expect, beforeEach } from 'vitest';
import {
  ATTENTION_QUEUES,
  visibleQueues,
  computeBadges,
  cachedBadges,
  accessKey,
  clearBadgeCache,
  type QueueAccess,
} from './attention-queues';

const admin: QueueAccess = { isAdmin: true, hasFeature: () => true };
const nobody: QueueAccess = { isAdmin: false, hasFeature: () => false };
const partsOnly: QueueAccess = { isAdmin: false, hasFeature: (k) => k === 'parts_ordering' };

/** A service double whose per-queue answers the test controls. */
function fakeService(answers: Record<string, number | null>) {
  return { __answers: answers } as any;
}

/** Replace each queue's count with the double's scripted answer. */
function withCounts(answers: Record<string, number | null>) {
  const original = ATTENTION_QUEUES.map(q => q.count);
  // `?? 0` here would turn a scripted null into 0 — the very conflation
  // these tests exist to catch. Use hasOwnProperty so null survives.
  ATTENTION_QUEUES.forEach(q => {
    q.count = async () => (Object.prototype.hasOwnProperty.call(answers, q.key) ? answers[q.key] : 0);
  });
  return () => ATTENTION_QUEUES.forEach((q, i) => { q.count = original[i]; });
}

describe('registry shape', () => {
  it('gives every queue a key, label and path', () => {
    for (const q of ATTENTION_QUEUES) {
      expect(q.key).toBeTruthy();
      expect(q.label.length).toBeGreaterThan(0);
      expect(q.path.startsWith('/')).toBe(true);
    }
  });
  it('has no duplicate keys', () => {
    const keys = ATTENTION_QUEUES.map(q => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('gates every queue on a feature or on admin — none is visible to everyone', () => {
    // A queue with no gate would show a count to people who cannot open it.
    for (const q of ATTENTION_QUEUES) {
      expect(!!q.feature || !!q.adminOnly, q.key).toBe(true);
    }
  });
});

describe('visibleQueues', () => {
  it('shows an admin everything', () => {
    expect(visibleQueues(admin)).toHaveLength(ATTENTION_QUEUES.length);
  });
  it('shows a user with no features nothing', () => {
    expect(visibleQueues(nobody)).toHaveLength(0);
  });
  it('shows only the queues a feature grants', () => {
    const keys = visibleQueues(partsOnly).map(q => q.key);
    expect(keys).toContain('purchase_requests');
    expect(keys).toContain('manual_receipts');
    expect(keys).not.toContain('pending_users');
    expect(keys).not.toContain('never_invoiced');
  });
});

describe('computeBadges', () => {
  let restore = () => {};
  beforeEach(() => { clearBadgeCache(); });

  it('sums the counts it got', async () => {
    restore = withCounts({ pending_users: 2, purchase_requests: 3 });
    const r = await computeBadges(fakeService({}), admin);
    restore();
    expect(r.total).toBeGreaterThanOrEqual(5);
    expect(r.unknown).toEqual([]);
  });

  it('EXCLUDES a failed count from the total instead of adding zero', async () => {
    restore = withCounts({ pending_users: null, purchase_requests: 4 });
    const r = await computeBadges(fakeService({}), admin);
    restore();
    expect(r.counts.pending_users).toBeNull();
    expect(r.unknown).toContain('pending_users');
    // The total must not pretend the unknown queue is empty.
    expect(r.total).toBe(Object.values(r.counts).filter((v): v is number => typeof v === 'number').reduce((a, b) => a + b, 0));
  });

  it('counts nothing for a caller with no queues', async () => {
    const r = await computeBadges(fakeService({}), nobody);
    expect(r.total).toBe(0);
    expect(Object.keys(r.counts)).toHaveLength(0);
    expect(r.unknown).toEqual([]);
  });
});

describe('cache', () => {
  beforeEach(() => { clearBadgeCache(); });

  it('keys on the access shape, so two different permission sets do not share', () => {
    expect(accessKey(admin)).not.toBe(accessKey(partsOnly));
    expect(accessKey(nobody)).toBe('none');
  });

  it('serves a second call from cache and says how old it is', async () => {
    const restore = withCounts({ pending_users: 1 });
    const first = await cachedBadges(fakeService({}), admin);
    const second = await cachedBadges(fakeService({}), admin);
    restore();
    expect(first.cacheAgeMs).toBe(0);
    expect(second.computedAt).toBe(first.computedAt);
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('does not serve one permission set from another set’s entry', async () => {
    const restore = withCounts({ pending_users: 7, purchase_requests: 1 });
    const a = await cachedBadges(fakeService({}), admin);
    const b = await cachedBadges(fakeService({}), partsOnly);
    restore();
    expect(Object.keys(a.counts).length).toBeGreaterThan(Object.keys(b.counts).length);
  });
});
