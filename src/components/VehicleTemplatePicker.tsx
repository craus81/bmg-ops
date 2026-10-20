'use client';

// The vehicle picker over the Art Station template library — one component
// for the Graphics Builder and the estimate, so both offer the same years,
// makes, models and body details (Craig 2026-10-19). See
// src/lib/vehicle-templates.ts for the shared vocabulary.
//
// Every dropdown is a filter, and each one's choices are what's left after
// applying all the OTHERS — so picking "Ford" + "Transit" leaves only the
// wheelbases and roofs a Transit actually comes in, and a dropdown with
// nothing to offer (bed length on a van) isn't shown. The database works the
// choices out (vehicle_template_filter_options, migration 345); retired
// templates are left out.

import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '@/lib/theme';
import { ROOF_ORDER } from '@/lib/template-facets';
import {
  EMPTY_FILTERS, EMPTY_FILTER_OPTIONS, FILTER_KEYS, normText, searchTemplates, templateLabel,
  type TemplateFilterKey, type TemplateFilters, type TemplateSearchResult, type VehicleTemplate,
} from '@/lib/vehicle-templates';

// The browse <select>: only once the filters narrow the library to a list
// a person can scroll (thousands of <option>s made every keystroke on the
// page slow).
const SELECT_LIST_MAX = 500;

const FILTER_FIELDS: [TemplateFilterKey, string, string, (v: string) => string][] = [
  ['year', 'All years', '110px', v => v],
  ['make', 'All makes', '150px', v => v],
  ['model', 'All models', '150px', v => v],
  ['body', 'Any body', '130px', v => v],
  ['wheelbase', 'Any wheelbase', '150px', v => (/\D/.test(v) ? v.replace(/^(\d+)/, '$1"') : `${v}" wheelbase`)],
  ['roof', 'Any roof', '120px', v => `${v} roof`],
  ['bed', 'Any bed', '120px', v => (['Chassis', 'Flat Bed', 'Flareside'].includes(v) ? v : `${v} bed`)],
  ['cab', 'Any cab', '130px', v => v],
];

export interface VehicleTemplatePickerProps {
  supabase: any;
  /** The picked template, if any. */
  template: VehicleTemplate | null;
  /** A template was picked: search result, browse list, or Enter. */
  onPick: (t: VehicleTemplate) => void;
  /** A filter changed, so the pick no longer stands. */
  onClear: () => void;
  /** Every filter change, for callers that keep the make / model without a template. */
  onFiltersChange?: (f: TemplateFilters) => void;
  /** Seeds the filters (an estimate opening with a make / model and no template). */
  initialFilters?: Partial<TemplateFilters> | null;
  /** Bump to re-seed from initialFilters (loading another record). */
  seedKey?: string | number;
  /** Puts text in the search box (a vehicle handed over from elsewhere). */
  searchSeed?: { text: string; n: number } | null;
  /** Bump when the library changes so the lists re-ask the database. */
  libraryVersion?: number;
  /** Active templates, for the empty-list placeholder. */
  libraryCount?: number | null;
  inputStyle: React.CSSProperties;
}

export default function VehicleTemplatePicker({
  supabase, template, onPick, onClear, onFiltersChange, initialFilters, seedKey,
  searchSeed, libraryVersion = 0, libraryCount, inputStyle,
}: VehicleTemplatePickerProps) {
  const [filterValues, setFilterValues] = useState<TemplateFilters>({ ...EMPTY_FILTERS, ...(initialFilters || {}) });
  const [search, setSearch] = useState('');
  // Seeded values the library may not list (an estimate's make / model with
  // no template behind it) are kept and shown until someone changes them.
  const seededKeys = (f?: Partial<TemplateFilters> | null) => FILTER_KEYS.filter(k => !!f?.[k]);
  const [pinned, setPinned] = useState<TemplateFilterKey[]>(() => seededKeys(initialFilters));
  const setFilters = (next: TemplateFilters) => {
    setFilterValues(next);
    setPinned(prev => prev.filter(k => next[k] && next[k] === filterValues[k]));
    onFiltersChange?.(next);
  };
  // The narrower filters describe one make's models, so a new make clears
  // them, and a new model clears its body details. Leaving them set made the
  // first pick of a new make fall back to the old one (Craig 2026-10-20:
  // "When I selected Ford for the make it would open Jeep"): the make
  // dropdown was asked for makes that have the old model, so Ford wasn't
  // among them and got dropped.
  const NARROWER: Partial<Record<TemplateFilterKey, TemplateFilterKey[]>> = {
    make: ['model', 'body', 'wheelbase', 'roof', 'bed', 'cab'],
    model: ['body', 'wheelbase', 'roof', 'bed', 'cab'],
  };
  // The dropdown the person just changed: if the others leave it stranded,
  // they give way, never the pick itself.
  const lastChanged = useRef<TemplateFilterKey | null>(null);
  const setFilter = (key: TemplateFilterKey, value: string) => {
    const next = { ...filterValues, [key]: value };
    (NARROWER[key] || []).forEach(k => { next[k] = ''; });
    lastChanged.current = value ? key : null;
    setFilters(next);
  };

  // Re-seed when the caller loads another record.
  useEffect(() => {
    if (seedKey === undefined) return;
    setFilterValues({ ...EMPTY_FILTERS, ...(initialFilters || {}) });
    setPinned(seededKeys(initialFilters));
    setSearch('');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seedKey stands for initialFilters
  }, [seedKey]);
  useEffect(() => {
    if (searchSeed) setSearch(searchSeed.text);
  }, [searchSeed]);

  // A template picked from outside the picker (a reopened worksheet, the
  // Templates grid, an estimate's vehicle) syncs the Year / Make filters to
  // it, so the browse <select> shows the pick instead of rendering blank
  // when a filter excludes it. The narrower filters stay only where the
  // pick satisfies them.
  useEffect(() => {
    if (!template) return;
    const t = template;
    const keep = (v: string, tv: string | null | undefined) => (v && normText(v) !== normText(tv) ? '' : v);
    const next: TemplateFilters = {
      year: (t.year || '').trim(),
      make: t.make.trim(),
      model: keep(filterValues.model, t.model),
      body: keep(filterValues.body, t.facet_body),
      wheelbase: keep(filterValues.wheelbase, t.facet_wheelbase),
      roof: keep(filterValues.roof, t.facet_roof),
      bed: keep(filterValues.bed, t.facet_bed),
      cab: keep(filterValues.cab, t.facet_cab),
    };
    if (FILTER_KEYS.some(k => next[k] !== filterValues[k])) setFilters(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the pick changes
  }, [template?.id]);

  const filterKey = JSON.stringify(filterValues);
  const anyFilter = Object.values(filterValues).some(Boolean);

  // Raw choices from the database, tagged with the filters they were asked
  // for so a slow answer to an older pick never lands on a newer one.
  const [rawFilterOptions, setRawFilterOptions] = useState<{ key: string; options: Record<TemplateFilterKey, string[]> } | null>(null);
  useEffect(() => {
    let stale = false;
    (async () => {
      // Make and model read top-down: the makes for the year, the models for
      // the year and make, so picking a model never hides the other makes
      // (Craig 2026-10-20: with a Wrangler picked, Ford wasn't in the Make
      // list and the pick fell back to Jeep). The body details below them
      // narrow by everything.
      const ask = (filters: Partial<TemplateFilters>) => supabase.rpc('vehicle_template_filter_options', { p_filters: filters });
      const { year, make } = filterValues;
      const [all, makes, models] = await Promise.all([
        ask(filterValues),
        ask({ year }),
        ask({ year, make }),
      ]);
      if (stale || all.error || !all.data || makes.error || models.error) return;
      setRawFilterOptions({
        key: filterKey,
        options: { ...EMPTY_FILTER_OPTIONS, ...all.data, make: makes.data?.make || [], model: models.data?.model || [] },
      });
    })();
    return () => { stale = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey stands for filterValues
  }, [filterKey, libraryVersion]);
  // Sorted for display. The database dedupes "FORD" / "Ford" (most common
  // spelling wins); the active value keeps its exact casing because a
  // <select> matches its value against options verbatim.
  const filterOptions: Record<TemplateFilterKey, string[]> = useMemo(() => {
    const raw = rawFilterOptions?.options || EMPTY_FILTER_OPTIONS;
    const sorted = (key: TemplateFilterKey): string[] => {
      const list = (raw[key] || []).map(o => (filterValues[key] && normText(o) === normText(filterValues[key]) ? filterValues[key] : o));
      // A seeded value the library doesn't list (an estimate's make with
      // no template) still shows rather than leaving the <select> blank.
      if (pinned.includes(key) && !list.includes(filterValues[key])) list.push(filterValues[key]);
      if (key === 'year') return list.sort().reverse();
      // "148" before "148 Extended" before "156".
      if (key === 'wheelbase') return list.sort((a, b) => parseFloat(a) - parseFloat(b) || a.length - b.length);
      if (key === 'roof') return list.sort((a, b) => ROOF_ORDER.indexOf(a) - ROOF_ORDER.indexOf(b));
      return list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    };
    return Object.fromEntries(FILTER_KEYS.map(k => [k, sorted(k)])) as Record<TemplateFilterKey, string[]>;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- filterValues only re-cases the active value
  }, [rawFilterOptions, pinned]);
  // Changing one filter can strand another (switch Ford → Ram with "Transit"
  // still picked): drop any value its dropdown no longer offers, so a filter
  // you can't see is never silently hiding templates. Only checked against
  // choices worked out for the filters as they stand now. Seeded values
  // are left alone (see pinned).
  useEffect(() => {
    if (!rawFilterOptions || rawFilterOptions.key !== filterKey) return;
    const raw = rawFilterOptions.options;
    const offered = (key: TemplateFilterKey) => (raw[key] || []).some(o => normText(o) === normText(filterValues[key]));
    const picked = lastChanged.current;
    lastChanged.current = null;
    let changed = false;
    const next = { ...filterValues };
    if (picked && next[picked] && !offered(picked)) {
      // Nothing matches the new pick together with the other filters
      // (a year Ford has no templates for): keep the pick, drop the rest.
      FILTER_KEYS.forEach(key => {
        if (key !== picked && next[key] && !pinned.includes(key)) { next[key] = ''; changed = true; }
      });
      if (changed) setFilters(next);
      return;
    }
    FILTER_KEYS.forEach(key => {
      if (pinned.includes(key)) return;
      if (next[key] && !(raw[key] || []).some(o => normText(o) === normText(next[key]))) { next[key] = ''; changed = true; }
    });
    if (changed) setFilters(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per answer
  }, [rawFilterOptions]);

  const [templateList, setTemplateList] = useState<{ key: string; rows: VehicleTemplate[]; total: number } | null>(null);
  useEffect(() => {
    if (!anyFilter) { setTemplateList(null); return; }
    let stale = false;
    (async () => {
      const res = await searchTemplates(supabase, { filters: filterValues, limit: SELECT_LIST_MAX });
      if (stale || !res) return;
      setTemplateList({ key: filterKey, rows: res.rows, total: res.total });
    })();
    return () => { stale = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey stands for filterValues
  }, [filterKey, libraryVersion]);
  const templateOptions = templateList?.key === filterKey && templateList.total <= SELECT_LIST_MAX ? templateList.rows : [];
  // The picked template stays listed even when the filters leave it out, so
  // the <select> never renders blank over a loaded drawing.
  const selectOptions = template && !templateOptions.some(t => t.id === template.id) ? [template, ...templateOptions] : templateOptions;
  const selectPlaceholder = !anyFilter
    ? `— Search or pick a make to list templates${libraryCount ? ` (${libraryCount.toLocaleString()})` : ''} —`
    : templateList?.key !== filterKey ? '— Loading templates… —'
    : templateList.total > SELECT_LIST_MAX ? `— ${templateList.total.toLocaleString()} templates; narrow the filters to list them —`
    : templateList.total === 0 ? '— No templates match these filters —'
    : '— Select vehicle template —';

  // Live type-ahead results for the search box: the database returns the
  // first 50 matches. The dropdowns act as filters on the search. Because a
  // leftover filter can make the search come up empty for a template that
  // plainly exists, the unfiltered count comes back too so the results can
  // say "N more without the filters".
  const [templateSearch, setTemplateSearch] = useState<{ query: string; key: string; result: TemplateSearchResult } | null>(null);
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setTemplateSearch(null); return; }
    let stale = false;
    const timer = setTimeout(async () => {
      const res = await searchTemplates(supabase, { query: q, filters: filterValues, limit: 50 });
      if (stale || !res) return;
      setTemplateSearch({ query: q, key: filterKey, result: res });
    }, 200);
    return () => { stale = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey stands for filterValues
  }, [search, filterKey, libraryVersion]);
  const searchCurrent = !!templateSearch && templateSearch.query === search.trim() && templateSearch.key === filterKey;
  const matches = templateSearch?.result.rows || [];
  const matchTotal = templateSearch?.result.total || 0;
  const hiddenByFilters = templateSearch ? templateSearch.result.unfilteredTotal - templateSearch.result.total : 0;

  const pick = (t: VehicleTemplate) => {
    setSearch('');
    onPick(t);
  };
  const clearFilters = () => { setFilters({ ...EMPTY_FILTERS }); onClear(); };

  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      {FILTER_FIELDS
        // Year / make / model always show; the rest only when the
        // templates left actually differ by them.
        .filter(([key]) => ['year', 'make', 'model'].includes(key) || filterOptions[key].length > 0)
        .map(([key, allLabel, width, label]) => (
          <select key={key} aria-label={allLabel} value={filterValues[key]} onChange={e => { setFilter(key, e.target.value); onClear(); }} style={{ ...inputStyle, width }}>
            <option value="">{allLabel}</option>
            {filterOptions[key].map(o => <option key={o} value={o}>{label(o)}</option>)}
          </select>
        ))}
      {anyFilter && (
        <button type="button" onClick={clearFilters} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 600 }}>Clear filters</button>
      )}
      <div style={{ position: 'relative', width: '220px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && searchCurrent && matches.length > 0) { e.preventDefault(); pick(matches[0]); }
            else if (e.key === 'Escape' && search) { e.preventDefault(); setSearch(''); }
          }}
          placeholder="Type to search templates…"
          style={{ ...inputStyle, width: '100%' }}
        />
        {search.trim().length >= 2 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, minWidth: '100%', width: 'max-content', maxWidth: '420px', zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '260px', overflowY: 'auto', marginTop: '2px' }}>
            {!templateSearch ? (
              <div style={{ padding: '8px 10px', fontSize: '11px', color: 'var(--text-muted)' }}>Searching…</div>
            ) : matches.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: '11px', color: 'var(--text-muted)' }}>{!searchCurrent ? 'Searching…' : hiddenByFilters > 0 ? 'No templates match with these filters' : 'No templates match'}</div>
            ) : matches.map(t => (
              <button type="button" key={t.id} onMouseDown={e => e.preventDefault()} onClick={() => pick(t)} style={{ display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)' }}>
                <span style={{ fontWeight: 700 }}>{templateLabel(t)}</span>
                {t.template_code && <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '10px' }}>{t.template_code}</span>}
              </button>
            ))}
            {matchTotal > matches.length && (
              <div style={{ padding: '6px 10px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>
                Showing {matches.length} of {matchTotal.toLocaleString()} matches — keep typing to narrow
              </div>
            )}
            {hiddenByFilters > 0 && (
              <button type="button" onMouseDown={e => e.preventDefault()} onClick={clearFilters} style={{ display: 'block', width: '100%', padding: '6px 10px', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '10px', color: '#06b6d4', fontWeight: 600 }}>
                {hiddenByFilters} more match without the filters — clear filters
              </button>
            )}
          </div>
        )}
      </div>
      <select
        aria-label="Vehicle template"
        value={template?.id || ''}
        onChange={e => {
          const t = selectOptions.find(o => o.id === e.target.value);
          if (t) pick(t); else onClear();
        }}
        style={{ ...inputStyle, flex: 1, minWidth: '220px' }}
      >
        <option value="">{selectPlaceholder}</option>
        {selectOptions.map(t => <option key={t.id} value={t.id}>{templateLabel(t)}{t.template_code ? ` (${t.template_code})` : ''}</option>)}
      </select>
    </div>
  );
}
