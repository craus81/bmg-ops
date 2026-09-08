import { describe, it, expect } from 'vitest';
import {
  parseVehicleDesc, clonePages, cloneSections, templateFromGuide,
  guideFromTemplate, rankTemplates, templateSummary, type GuideLike,
} from './guide-templates';

const guide = (over: Partial<GuideLike> = {}): GuideLike => ({
  id: 'g1',
  title: 'Acme Transit wrap',
  customer_name: 'Acme Fleet',
  vehicle_desc: '2024 Ford Transit 148 High Roof',
  scale: '1:20', units: 'in', fraction_denominator: 8,
  pages: [{ id: 'p1', px_per_in: 12, dims: [{ id: 'd1', label: '48"' }, { id: 'd2', label: '12"' }] }],
  sections: [{ id: 's1', title: 'Surface prep' }],
  graphics_job_id: 'gfx-1',
  ...over,
});

describe('parseVehicleDesc', () => {
  it('pulls year, make and model out of the usual shape', () => {
    expect(parseVehicleDesc('2024 Ford Transit 148 High Roof'))
      .toEqual({ year: '2024', make: 'Ford', model: 'Transit 148 High Roof' });
  });

  it('copes with no year', () => {
    expect(parseVehicleDesc('Ford Transit')).toEqual({ year: null, make: 'Ford', model: 'Transit' });
  });

  it('returns nulls rather than guessing at nothing', () => {
    expect(parseVehicleDesc('')).toEqual({ year: null, make: null, model: null });
    expect(parseVehicleDesc(null)).toEqual({ year: null, make: null, model: null });
  });
});

describe('clonePages / cloneSections', () => {
  it('gives every page, dimension and section a NEW id', () => {
    // Sharing ids means a tool addressing a dimension by id can act on
    // the wrong document.
    const pages = clonePages(guide().pages);
    expect(pages[0].id).not.toBe('p1');
    expect(pages[0].dims!.map(d => d.id)).not.toContain('d1');
    expect(cloneSections(guide().sections)[0].id).not.toBe('s1');
  });

  it('keeps everything except the ids — the calibration is the point', () => {
    const pages = clonePages(guide().pages);
    expect(pages[0].px_per_in).toBe(12);
    expect(pages[0].dims![0].label).toBe('48"');
  });

  it('survives a guide with no pages at all', () => {
    expect(clonePages(null)).toEqual([]);
    expect(cloneSections(undefined)).toEqual([]);
  });
});

describe('templateFromGuide', () => {
  const t = templateFromGuide(guide(), 'Transit 148 HR standard', { year: '2024', make: 'Ford', model: 'Transit 148 High Roof' });

  it('strips the customer — a template must not print somebody else’s name', () => {
    expect(t.customer_name).toBeNull();
  });

  it('strips every job link — a clone must not attach to the ORIGINAL job', () => {
    expect(t.graphics_job_id).toBeNull();
    expect(t.cni_job_id).toBeNull();
    expect(t.fleet_checkin_id).toBeNull();
  });

  it('keeps the calibration and the dimension set', () => {
    expect(t.pages[0].px_per_in).toBe(12);
    expect(t.pages[0].dims).toHaveLength(2);
    expect(t.fraction_denominator).toBe(8);
  });

  it('keys the template to its vehicle', () => {
    expect(t.template_make).toBe('Ford');
    expect(t.template_model).toBe('Transit 148 High Roof');
    expect(t.is_template).toBe(true);
  });
});

describe('guideFromTemplate', () => {
  const template = { ...templateFromGuide(guide(), 'Transit standard', { make: 'Ford', model: 'Transit' }), id: 't1' } as GuideLike;

  it('takes the new job’s customer and links, not the template’s', () => {
    const g = guideFromTemplate(template, {
      title: 'Globex Transit', customerName: 'Globex', graphicsJobId: 'gfx-9',
    });
    expect(g.customer_name).toBe('Globex');
    expect(g.graphics_job_id).toBe('gfx-9');
    expect(g.is_template).toBe(false);
  });

  it('records where it came from', () => {
    expect(guideFromTemplate(template, {}).created_from_template_id).toBe('t1');
  });

  it('clones with fresh ids', () => {
    const a = guideFromTemplate(template, {});
    const b = guideFromTemplate(template, {});
    expect(a.pages[0].id).not.toBe(b.pages[0].id);
  });
});

describe('rankTemplates', () => {
  const t = (name: string, make: string | null, model: string | null, year: string | null = null): GuideLike =>
    ({ id: name, template_name: name, template_make: make, template_model: model, template_year: year });

  it('puts the model match first and says why', () => {
    const ranked = rankTemplates(
      [t('Sprinter', 'Mercedes', 'Sprinter'), t('Transit', 'Ford', 'Transit')],
      { make: 'Ford', model: 'Transit', year: '2024' },
    );
    expect(ranked[0].template.template_name).toBe('Transit');
    expect(ranked[0].reason).toContain('Matches');
  });

  it('offers last year’s template rather than sending somebody back to scratch', () => {
    // A body style rarely changes year to year; the year is a tiebreak,
    // never a filter.
    const ranked = rankTemplates([t('Transit', 'Ford', 'Transit', '2022')], { make: 'Ford', model: 'Transit', year: '2024' });
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('keeps a non-matching template reachable, with its reason said out loud', () => {
    const ranked = rankTemplates([t('Sprinter', 'Mercedes', 'Sprinter')], { make: 'Ford', model: 'Transit' });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBe(0);
    expect(ranked[0].reason).toContain('different vehicle');
  });

  it('says so when a template was never keyed to a vehicle', () => {
    expect(rankTemplates([t('Generic', null, null)], { make: 'Ford' })[0].reason)
      .toBe('Not keyed to a vehicle');
  });

  it('ranks everything equally when the job has no vehicle on it', () => {
    const ranked = rankTemplates([t('A', 'Ford', 'Transit'), t('B', 'Mercedes', 'Sprinter')], {});
    expect(ranked.every(r => r.score === 0)).toBe(true);
  });
});

describe('templateSummary', () => {
  it('says how much reusable work is in it', () => {
    expect(templateSummary(guide())).toBe('1 page · 2 dimensions · 1 section');
  });
  it('is honest about an empty one', () => {
    expect(templateSummary({ pages: [], sections: [] })).toBe('Empty template');
  });
});
