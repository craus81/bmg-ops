'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  ResponsiveGridLayout as RGL,
  useContainerWidth,
  verticalCompactor,
  type LayoutItem,
  type Layout,
} from 'react-grid-layout';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import {
  WIDGET_REGISTRY,
  WIDGET_MAP,
  DEFAULT_WIDGET_IDS,
  generateDefaultLayout,
  generateMobileDefaultLayout,
} from './widgetRegistry';

// Lazy-load widgets so the grid renders fast
const OpenPOsWidget = lazy(() => import('./OpenPOsWidget'));
const NeedsAttentionWidget = lazy(() => import('./NeedsAttentionWidget'));
const RevenueSummaryWidget = lazy(() => import('./RevenueSummaryWidget'));
const ActiveJobsWidget = lazy(() => import('./ActiveJobsWidget'));
const TopCustomersWidget = lazy(() => import('./TopCustomersWidget'));
const CniOverviewWidget = lazy(() => import('./CniOverviewWidget'));
const UpcomingScheduleWidget = lazy(() => import('./UpcomingScheduleWidget'));
const RecentMessagesWidget = lazy(() => import('./RecentMessagesWidget'));
const TimeClockWidget = lazy(() => import('./TimeClockWidget'));
const OpenQuotesWidget = lazy(() => import('./OpenQuotesWidget'));
const QuickActionsWidget = lazy(() => import('./QuickActionsWidget'));
const FleetCheckInWidget = lazy(() => import('./FleetCheckInWidget'));
const GraphicsProductionWidget = lazy(() => import('./GraphicsProductionWidget'));
const InShopTrackingWidget = lazy(() => import('./InShopTrackingWidget'));
const VehiclesWidget = lazy(() => import('./VehiclesWidget'));
const EstimatesWidget = lazy(() => import('./EstimatesWidget'));
const CustomersWidget = lazy(() => import('./CustomersWidget'));
const PartsCatalogWidget = lazy(() => import('./PartsCatalogWidget'));
const PhotoReviewsWidget = lazy(() => import('./PhotoReviewsWidget'));
const UserManagementWidget = lazy(() => import('./UserManagementWidget'));
const VendorPaymentsWidget = lazy(() => import('./VendorPaymentsWidget'));
const PurchaseOrdersWidget = lazy(() => import('./PurchaseOrdersWidget'));
const ReportsWidget = lazy(() => import('./ReportsWidget'));
const MyJobsWidget = lazy(() => import('./MyJobsWidget'));
const SalesPipelineWidget = lazy(() => import('./SalesPipelineWidget'));
const MyAccountsWidget = lazy(() => import('./MyAccountsWidget'));

const WIDGET_COMPONENTS: Record<string, React.LazyExoticComponent<any>> = {
  open_pos: OpenPOsWidget,
  needs_attention: NeedsAttentionWidget,
  revenue_summary: RevenueSummaryWidget,
  active_jobs: ActiveJobsWidget,
  top_customers: TopCustomersWidget,
  cni_overview: CniOverviewWidget,
  upcoming_schedule: UpcomingScheduleWidget,
  recent_messages: RecentMessagesWidget,
  time_clock: TimeClockWidget,
  open_quotes: OpenQuotesWidget,
  quick_actions: QuickActionsWidget,
  fleet_checkin: FleetCheckInWidget,
  graphics_production: GraphicsProductionWidget,
  in_shop_tracking: InShopTrackingWidget,
  vehicles: VehiclesWidget,
  estimates: EstimatesWidget,
  customers: CustomersWidget,
  parts_catalog: PartsCatalogWidget,
  photo_reviews: PhotoReviewsWidget,
  user_management: UserManagementWidget,
  vendor_payments: VendorPaymentsWidget,
  purchase_orders: PurchaseOrdersWidget,
  reports: ReportsWidget,
  my_jobs: MyJobsWidget,
  sales_pipeline: SalesPipelineWidget,
  my_accounts: MyAccountsWidget,
};

const ROW_HEIGHT = 90;
const MOBILE_BREAKPOINT = 600;

function WidgetLoader() {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
    }}>
      <div style={{
        width: '24px', height: '24px', border: '2px solid var(--border)',
        borderTopColor: 'var(--navy)', borderRadius: '50%',
        animation: 'spin 1s linear infinite',
      }} />
    </div>
  );
}

// Reattach min/max constraints from registry onto a stored layout entry,
// and clamp w/h up to the current min so previously-saved tiny widgets
// can't end up below the grabbable-handle floor.
function enrich(layoutArr: LayoutItem[], mobile: boolean): LayoutItem[] {
  return layoutArr.map((l) => {
    const def = WIDGET_MAP[l.i];
    if (!def) return l;
    const minW = (mobile ? def.minMobileW : def.minW) ?? def.minW;
    const minH = (mobile ? def.minMobileH : def.minH) ?? def.minH;
    return {
      ...l,
      w: minW ? Math.max(l.w, minW) : l.w,
      h: minH ? Math.max(l.h, minH) : l.h,
      minW,
      minH,
      maxW: def.maxW,
      maxH: def.maxH,
    };
  });
}

export default function DashboardGrid() {
  const { user } = useAuth();
  const supabase = createClient();
  const { width, containerRef } = useContainerWidth();
  const [activeWidgets, setActiveWidgets] = useState<string[]>(DEFAULT_WIDGET_IDS);
  const [lgLayout, setLgLayout] = useState<LayoutItem[]>(generateDefaultLayout(DEFAULT_WIDGET_IDS) as LayoutItem[]);
  const [smLayout, setSmLayout] = useState<LayoutItem[]>(generateMobileDefaultLayout(DEFAULT_WIDGET_IDS) as LayoutItem[]);
  const [isEditing, setIsEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const isMobile = (width || 0) < MOBILE_BREAKPOINT;
  // Keep latest values available to async save callbacks without rebinding them
  const stateRef = useRef({ activeWidgets, lgLayout, smLayout, isMobile });
  stateRef.current = { activeWidgets, lgLayout, smLayout, isMobile };

  useEffect(() => {
    if (!user?.id) return;
    loadLayout();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user?.id]);

  const loadLayout = async () => {
    const { data } = await supabase
      .from('dashboard_layouts')
      .select('layout, widgets')
      .eq('user_id', user!.id)
      .single();

    if (data) {
      const widgets = (data.widgets || []) as string[];
      const validWidgets = widgets.filter((id: string) => WIDGET_MAP[id]);
      const raw = data.layout;

      // Two stored shapes: legacy `LayoutItem[]` (lg only) or `{ lg, sm }`
      let storedLg: LayoutItem[] = [];
      let storedSm: LayoutItem[] = [];
      if (Array.isArray(raw)) {
        storedLg = raw as LayoutItem[];
      } else if (raw && typeof raw === 'object') {
        storedLg = (raw.lg || []) as LayoutItem[];
        storedSm = (raw.sm || []) as LayoutItem[];
      }

      if (validWidgets.length > 0) {
        setActiveWidgets(validWidgets);
        const lgFiltered = storedLg.filter((l) => validWidgets.includes(l.i));
        setLgLayout(enrich(lgFiltered.length > 0 ? lgFiltered : (generateDefaultLayout(validWidgets) as LayoutItem[]), false));

        const smFiltered = storedSm.filter((l) => validWidgets.includes(l.i));
        setSmLayout(enrich(smFiltered.length > 0 ? smFiltered : (generateMobileDefaultLayout(validWidgets) as LayoutItem[]), true));
      }
    }
    setLoaded(true);
  };

  const saveLayout = useCallback(async (widgetIds: string[], lg: readonly LayoutItem[], sm: readonly LayoutItem[]) => {
    if (!user?.id) return;
    setSaving(true);
    const cleanLg = lg.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
    const cleanSm = sm.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
    await supabase
      .from('dashboard_layouts')
      .upsert({
        user_id: user.id,
        layout: { lg: cleanLg, sm: cleanSm },
        widgets: widgetIds,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    setSaving(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user?.id]);

  const handleLayoutChange = useCallback((newLayout: Layout) => {
    const copy = [...newLayout];
    if (stateRef.current.isMobile) setSmLayout(copy);
    else setLgLayout(copy);
  }, []);

  const toggleWidget = (widgetId: string) => {
    setActiveWidgets(prev => {
      if (prev.includes(widgetId)) {
        const next = prev.filter(id => id !== widgetId);
        setLgLayout(old => old.filter((l) => l.i !== widgetId));
        setSmLayout(old => old.filter((l) => l.i !== widgetId));
        return next;
      } else {
        const def = WIDGET_MAP[widgetId];
        if (!def) return prev;
        const lgMaxY = lgLayout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
        const lgItem: LayoutItem = {
          i: widgetId, x: 0, y: lgMaxY, w: def.defaultW, h: def.defaultH,
          minW: def.minW, minH: def.minH, maxW: def.maxW, maxH: def.maxH,
        };
        setLgLayout(old => [...old, lgItem]);

        const smMaxY = smLayout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
        const smItem: LayoutItem = {
          i: widgetId, x: 0, y: smMaxY,
          w: def.defaultMobileW ?? def.defaultW,
          h: def.defaultMobileH ?? def.defaultH,
          minW: def.minMobileW ?? def.minW,
          minH: def.minMobileH ?? def.minH,
          maxW: def.maxW, maxH: def.maxH,
        };
        setSmLayout(old => [...old, smItem]);
        return [...prev, widgetId];
      }
    });
  };

  const handleDoneEditing = () => {
    setIsEditing(false);
    setShowPicker(false);
    saveLayout(activeWidgets, lgLayout, smLayout);
  };

  const handleDragStop = useCallback((...args: unknown[]) => {
    const layout = args[0] as Layout;
    const s = stateRef.current;
    const nextLg = s.isMobile ? s.lgLayout : [...layout];
    const nextSm = s.isMobile ? [...layout] : s.smLayout;
    setTimeout(() => { saveLayout(s.activeWidgets, nextLg, nextSm); }, 100);
  }, [saveLayout]);

  const handleResizeStop = useCallback((...args: unknown[]) => {
    const layout = args[0] as Layout;
    const s = stateRef.current;
    const nextLg = s.isMobile ? s.lgLayout : [...layout];
    const nextSm = s.isMobile ? [...layout] : s.smLayout;
    setTimeout(() => { saveLayout(s.activeWidgets, nextLg, nextSm); }, 100);
  }, [saveLayout]);

  if (!loaded) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '12px', fontSize: '13px' }}>Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div ref={containerRef as any} style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', boxSizing: 'border-box' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '12px',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Dashboard
          {saving && <span style={{ marginLeft: '8px', color: theme.textMuted, fontWeight: 500, fontSize: '10px' }}>Saving...</span>}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {isEditing ? (
            <>
              <button onClick={() => setShowPicker(!showPicker)} style={{
                padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: showPicker ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                border: `1px solid ${showPicker ? 'var(--tab-active-border)' : theme.border}`,
                color: showPicker ? 'var(--tab-active-color)' : theme.textPrimary,
                cursor: 'pointer',
              }}>+ Widgets</button>
              <button onClick={handleDoneEditing} style={{
                padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: 'var(--success-bg)', border: '1px solid var(--success-border)',
                color: 'var(--success)', cursor: 'pointer',
              }}>Done</button>
            </>
          ) : (
            <button onClick={() => setIsEditing(true)} style={{
              padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`,
              color: theme.textMuted, cursor: 'pointer',
            }}>Customize</button>
          )}
        </div>
      </div>

      {/* Widget Picker Panel */}
      {showPicker && (
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', marginBottom: '12px', boxShadow: theme.shadowMd,
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>
            Toggle Widgets
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            {WIDGET_REGISTRY.map(w => {
              const active = activeWidgets.includes(w.id);
              return (
                <button key={w.id} onClick={() => toggleWidget(w.id)} style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '10px', borderRadius: '10px', border: 'none', textAlign: 'left',
                  background: active ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                  outline: active ? '2px solid var(--tab-active-border)' : 'none',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}>
                  <span style={{ fontSize: '18px' }}>{w.icon}</span>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: active ? 'var(--tab-active-color)' : theme.textPrimary }}>
                      {w.label}
                    </div>
                    <div style={{ fontSize: '9px', color: theme.textMuted }}>{w.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Edit mode hint */}
      {isEditing && !showPicker && (
        <div style={{
          textAlign: 'center', padding: '8px', marginBottom: '8px',
          fontSize: '11px', color: theme.textMuted, fontWeight: 600,
          background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
          borderRadius: '8px',
        }}>
          {isMobile
            ? 'Drag to rearrange · Resize from bottom-right · Mobile layout saves separately'
            : 'Drag widgets to rearrange · Resize from bottom-right corner'}
        </div>
      )}

      {/* Grid */}
      {activeWidgets.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '60px 20px',
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
        }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}></div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>No widgets enabled</div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>
            Click &quot;Customize&quot; then &quot;+ Widgets&quot; to add some
          </div>
        </div>
      ) : (
        <RGL
          className="dashboard-grid"
          width={Math.max((width || 400), 300)}
          layouts={{ lg: lgLayout, sm: smLayout }}
          breakpoints={{ lg: MOBILE_BREAKPOINT, sm: 0 }}
          cols={{ lg: 4, sm: 4 }}
          rowHeight={ROW_HEIGHT}
          dragConfig={{ enabled: isEditing, handle: '.widget-drag-handle' }}
          resizeConfig={{ enabled: isEditing }}
          onLayoutChange={handleLayoutChange}
          onDragStop={handleDragStop}
          onResizeStop={handleResizeStop}
          compactor={verticalCompactor}
          margin={[8, 8] as [number, number]}
          containerPadding={[8, 8] as [number, number]}
        >
          {activeWidgets.map(widgetId => {
            const Component = WIDGET_COMPONENTS[widgetId];
            if (!Component) return null;
            return (
              <div key={widgetId} style={{ position: 'relative' }}>
                {isEditing && (
                  <div className="widget-drag-handle" style={{
                    position: 'absolute', top: 0, left: 0, right: 0, height: '36px',
                    cursor: 'grab', zIndex: 10,
                    background: 'linear-gradient(180deg, rgba(238,49,32,0.06) 0%, transparent 100%)',
                    borderRadius: '14px 14px 0 0',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <div style={{ width: '32px', height: '4px', borderRadius: '2px', background: 'var(--orange)', opacity: 0.4 }} />
                  </div>
                )}
                <Suspense fallback={<WidgetLoader />}>
                  <Component />
                </Suspense>
              </div>
            );
          })}
        </RGL>
      )}
    </div>
  );
}
