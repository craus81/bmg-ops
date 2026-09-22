import { describe, it, expect } from 'vitest';
import {
  evaluateCompany, evaluateInstaller, daysUntil, dueThreshold, thresholdLabel,
  WARN_THRESHOLDS, type CompanySubject, type InstallerSubject,
} from './cni-compliance';

const TODAY = '2026-06-10';

const company = (over: Partial<CompanySubject> = {}): CompanySubject => ({
  id: 'c1', name: 'Acme Installs',
  w9_file_path: 'w9.pdf', insurance_cert_path: 'ins.pdf', insurance_expiry: '2026-12-31',
  ...over,
});

const installer = (over: Partial<InstallerSubject> = {}): InstallerSubject => ({
  user_id: 'u1', full_name: 'Dana',
  w9_file_path: 'w9.pdf', insurance_cert_path: 'ins.pdf', insurance_expiry: '2026-12-31',
  terms_accepted_at: '2026-01-01T00:00:00Z',
  install_expectations_accepted_at: '2026-01-01T00:00:00Z',
  timeline_agreement_accepted_at: '2026-01-01T00:00:00Z',
  ...over,
});

describe('daysUntil', () => {
  it('counts whole days forward and backward', () => {
    expect(daysUntil('2026-06-20', TODAY)).toBe(10);
    expect(daysUntil('2026-06-10', TODAY)).toBe(0);
    expect(daysUntil('2026-06-01', TODAY)).toBe(-9);
  });
  it('returns null for a missing or unparseable date, never 0', () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil('not a date', TODAY)).toBeNull();
  });
  it('tolerates a timestamp where a date was expected', () => {
    expect(daysUntil('2026-06-20T14:00:00Z', TODAY)).toBe(10);
  });
});

describe('evaluateCompany', () => {
  it('passes a company with every document and live insurance', () => {
    const s = evaluateCompany(company(), TODAY);
    expect(s.eligible).toBe(true);
    expect(s.state).toBe('compliant');
    expect(s.blocking).toEqual([]);
  });

  it('fails a company with no W-9, naming what is missing', () => {
    const s = evaluateCompany(company({ w9_file_path: null }), TODAY);
    expect(s.eligible).toBe(false);
    expect(s.blocking).toContain('W-9');
    expect(s.requirements.find(r => r.key === 'w9')?.detail).toMatch(/No W-9/);
  });

  it('treats an UNDATED certificate as not compliant, and says why', () => {
    // The rule this file exists for: a PDF with no expiry proves nothing.
    const s = evaluateCompany(company({ insurance_expiry: null }), TODAY);
    expect(s.eligible).toBe(false);
    expect(s.state).toBe('incomplete');
    expect(s.requirements.find(r => r.key === 'insurance_cert')?.detail)
      .toMatch(/no expiry date was recorded/);
  });

  it('distinguishes a MISSING certificate from an undated one', () => {
    const s = evaluateCompany(company({ insurance_cert_path: null, insurance_expiry: null }), TODAY);
    expect(s.requirements.find(r => r.key === 'insurance_cert')?.detail).toBe('No certificate on file.');
  });

  it('marks a passed expiry lapsed, with how long ago', () => {
    const s = evaluateCompany(company({ insurance_expiry: '2026-06-03' }), TODAY);
    expect(s.state).toBe('lapsed');
    expect(s.eligible).toBe(false);
    expect(s.daysToExpiry).toBe(-7);
    expect(s.requirements.find(r => r.key === 'insurance_cert')?.detail).toMatch(/Expired 7 days ago/);
  });

  it('is still ELIGIBLE but flagged expiring inside the warning window', () => {
    const s = evaluateCompany(company({ insurance_expiry: '2026-06-25' }), TODAY);
    expect(s.eligible).toBe(true);
    expect(s.state).toBe('expiring');
    expect(s.daysToExpiry).toBe(15);
  });

  it('expires exactly today: still covered, so eligible — but at the last rung', () => {
    const s = evaluateCompany(company({ insurance_expiry: TODAY }), TODAY);
    expect(s.daysToExpiry).toBe(0);
    expect(s.eligible).toBe(true);
    expect(s.state).toBe('expiring');
  });
});

describe('evaluateInstaller', () => {
  it('passes a fully onboarded installer', () => {
    expect(evaluateInstaller(installer(), TODAY).eligible).toBe(true);
  });

  it('blocks on any unaccepted agreement and names it', () => {
    const s = evaluateInstaller(installer({ timeline_agreement_accepted_at: null }), TODAY);
    expect(s.eligible).toBe(false);
    expect(s.blocking).toEqual(['Timeline agreement accepted']);
  });

  it('lists every unmet requirement rather than stopping at the first', () => {
    const s = evaluateInstaller(installer({
      w9_file_path: null, terms_accepted_at: null, insurance_cert_path: null, insurance_expiry: null,
    }), TODAY);
    expect(s.blocking).toHaveLength(3);
  });

  it('falls back to the business name when the person has none', () => {
    expect(evaluateInstaller(installer({ full_name: null, company_name: 'Acme' }), TODAY).name).toBe('Acme');
  });
});

describe('dueThreshold', () => {
  it('fires the lowest reached rung, not every rung at once', () => {
    // 5 days out with nothing sent: 30, 14 and 7 have all been "reached",
    // but the person needs ONE warning, and it should be the urgent one.
    expect(dueThreshold(5, [])).toBe(7);
  });

  it('walks down the ladder as the date approaches', () => {
    expect(dueThreshold(14, [30])).toBe(14);
    expect(dueThreshold(7, [30, 14])).toBe(7);
    expect(dueThreshold(2, [30, 14, 7])).toBe(3);
    expect(dueThreshold(-1, [30, 14, 7, 3])).toBe(0);
  });

  it('stays quiet BETWEEN rungs — a warning a day is how people learn to ignore them', () => {
    // 20 days out, the 30-day warning already sent: the next thing to say
    // is the 14-day one, and it is not due yet.
    expect(dueThreshold(20, [30])).toBeNull();
    expect(dueThreshold(9, [30, 14])).toBeNull();
  });

  it('goes quiet once every rung has been sent', () => {
    expect(dueThreshold(-30, [30, 14, 7, 3, 0])).toBeNull();
  });

  it('says nothing while the date is still far out', () => {
    expect(dueThreshold(60, [])).toBeNull();
  });

  it('says nothing at all when there is no expiry date', () => {
    // An undated certificate is a compliance PROBLEM, but it is not an
    // expiry warning — there is no date to count down to.
    expect(dueThreshold(null, [])).toBeNull();
  });

  it('re-arms for a renewed certificate, because sent rungs are keyed to the OLD expiry', () => {
    // The loader passes only the rungs recorded against THIS expiry date.
    expect(dueThreshold(25, [])).toBe(30);
  });
});

describe('thresholdLabel', () => {
  it('reads naturally on each rung', () => {
    expect(thresholdLabel(30, 30)).toBe('expires in 30 days');
    expect(thresholdLabel(3, 1)).toBe('expires in 1 day');
    expect(thresholdLabel(0, 0)).toBe('expires today');
    expect(thresholdLabel(0, -1)).toBe('expired 1 day ago');
    expect(thresholdLabel(0, -9)).toBe('expired 9 days ago');
  });
});

describe('failure reasons', () => {
  it('codes each insurance failure so a count never depends on message wording', () => {
    expect(evaluateCompany(company({ insurance_cert_path: null, insurance_expiry: null }), TODAY)
      .requirements.find(r => r.key === 'insurance_cert')?.reason).toBe('missing');
    expect(evaluateCompany(company({ insurance_expiry: null }), TODAY)
      .requirements.find(r => r.key === 'insurance_cert')?.reason).toBe('undated');
    expect(evaluateCompany(company({ insurance_expiry: '2026-01-01' }), TODAY)
      .requirements.find(r => r.key === 'insurance_cert')?.reason).toBe('expired');
  });

  it('leaves a met requirement uncoded', () => {
    expect(evaluateCompany(company(), TODAY).requirements.every(r => r.met && !r.reason)).toBe(true);
  });

  it('codes an unaccepted agreement distinctly from a missing document', () => {
    const s = evaluateInstaller(installer({ terms_accepted_at: null, w9_file_path: null }), TODAY);
    expect(s.requirements.find(r => r.key === 'terms')?.reason).toBe('not_accepted');
    expect(s.requirements.find(r => r.key === 'w9')?.reason).toBe('missing');
  });
});

describe('the warning ladder', () => {
  it('descends and ends at the lapse itself', () => {
    expect([...WARN_THRESHOLDS]).toEqual([30, 14, 7, 3, 0]);
  });
});
