'use client';

import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import {
  ResponsiveGridLayout as RGL,
  useContainerWidth,
  verticalCompactor,
  type LayoutItem,
  type Layout,
  type ResponsiveLayouts,
} from 'react-grid-layout';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import { WIDGET_REGISTRY, WIDGET_MAP, DEFAULT_WIDGET_IDS, generateDefaultLayout } from './widgetRegistry';

// Generate a mobile layout from widget IDs: 2-column grid, each widget 1 col wide, taller
function generateMobileLayout(widgetIds: string[]): LayoutItem[] {
  let x = 0;
  let y = 0;
  let rowMaxH = 0;
  return widgetIds.map(id => {
    const def = WIDGET_MAP[id];
    if (!def) return null;
    const h = Math.max((def.defaultH || 2) + 1, def.minH || 1);
    if (x >= 2) { x = 0; y += rowMaxH; rowMaxH = 0; }
    const item: LayoutItem = { i: id, x, y, w: 1, h, minW: 1, minH: def.minH, maxH: def.maxH };
    rowMaxH = Math.max(rowMaxH, h);
    x += 1;
    return item;
  }).filter(Boolean) as LayoutItem[];
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
};

const ROW_HEIGHT = 90;

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

export default function DashboardGrid() {
  const { user } = useAuth();
  const supabase = createClient();
  const { width, containerRef, mounted } = useContainerWidth();
  const [activeWidgets, setActiveWidgets] = useState<string[]>(DEFAULT_WIDGET_IDS);
  const [lgLayout, setLgLayout] = useState<LayoutItem[]>(generateDefaultLayout(DEFAULT_WIDGET_IDS) as LayoutItem[]);
  const [isEditing, setIsEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load saved layout on mount
  useEffect(() => {
    if (!user?.id) return;
    loadLayout();
  }, [user?.id]);

  const loadLayout = async () => {
    const { data } = await supabase
      .from('dashboard_layouts')
      .select('layout, widgets')
      .eq('user_id', user!.id)
      .single();

    if (data) {
      const widgets = (data.widgets || []) as string[];
      const layout = (data.layout || []) as LayoutItem[];
      const validWidgets = widgets.filter((id: string) => WIDGET_MAP[id]);
      if (validWidgets.length > 0) {
        setActiveWidgets(validWidgets);
        const enriched: LayoutItem[] = layout
          .filter((l: LayoutItem) => validWidgets.includes(l.i))
          .map((l: LayoutItem) => {
            const def = WIDGET_MAP[l.i];
            return { ...l, minW: def?.minW, minH: def?.minH, maxW: def?.maxW, maxH: def?.maxH };
          });
        setLgLayout(enriched);
      }
    }
    setLoaded(true);
  };

  const saveLayout = useCallback(async (widgetIds: string[], layoutArr: readonly LayoutItem[]) => {
    if (!user?.id) return;
    setSaving(true);
    const clean = layoutArr.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
    await supabase
      .from('dashboard_layouts')
      .upsert({
        user_id: user.id,
        layout: clean,
        widgets: widgetIds,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    setSaving(false);
  }, [user?.id]);

  const handleLayoutChange = useCallback((newLayout: Layout) => {
    // Layout is readonly LayoutItem[], need to copy for state
    setLgLayout([...newLayout]);
  }, []);

  const toggleWidget = (widgetId: string) => {
    setActiveWidgets(prev => {
      if (prev.includes(widgetId)) {
        const next = prev.filter(id => id !== widgetId);
        setLgLayout(old => old.filter((l) => l.i !== widgetId));
        return next;
      } else {
        const def = WIDGET_MAP[widgetId];
        if (!def) return prev;
        const maxY = lgLayout.reduce((max: number, l) => Math.max(max, l.y + l.h), 0);
        const newItem: LayoutItem = {
          i: widgetId, x: 0, y: maxY, w: def.defaultW, h: def.defaultH,
          minW: def.minW, minH: def.minH, maxW: def.maxW, maxH: def.maxH,
        };
        setLgLayout(old => [...old, newItem]);
        return [...prev, widgetId];
      }
    });
  };

  const handleDoneEditing = () => {
    setIsEditing(false);
    setShowPicker(false);
    saveLayout(activeWidgets, lgLayout);
  };

  const handleDragStop = useCallback((...args: unknown[]) => {
    // In v2, onDragStop passes (layout, oldItem, newItem, placeholder, e, element)
    const layout = args[0] as Layout;
    setTimeout(() => { saveLayout(activeWidgets, layout); }, 100);
  }, [activeWidgets, saveLayout]);

  const handleResizeStop = useCallback((...args: unknown[]) => {
    const layout = args[0] as Layout;
    setTimeout(() => { saveLayout(activeWidgets, layout); }, 100);
  }, [activeWidgets, saveLayout]);

  if (!loaded) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '12px', fontSize: '13px' }}>Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', boxSizing: 'border-box' }}>
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
          Drag widgets to rearrange &bull; Resize from bottom-right corner
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
          layouts={{ lg: lgLayout, sm: generateMobileLayout(activeWidgets) }}
          breakpoints={{ lg: 600, sm: 0 }}
          cols={{ lg: 4, sm: 2 }}
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
