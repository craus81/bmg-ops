// Widget Registry — defines all available dashboard widgets
// Each widget has a default size (w x h in grid units) and metadata

export interface WidgetDef {
  id: string;
  label: string;
  icon: string;
  description: string;
  defaultW: number;  // grid columns (out of 4)
  defaultH: number;  // grid rows (1 row ≈ 140px)
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export const WIDGET_REGISTRY: WidgetDef[] = [
  {
    id: 'active_jobs',
    label: 'Active Jobs',
    icon: '',
    description: 'Open jobs count and quick list',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'needs_attention',
    label: 'Needs Attention',
    icon: '',
    description: 'Pending photos, invoices, and bids',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'top_customers',
    label: 'Top 5 Customers YTD',
    icon: '',
    description: 'Highest-revenue customers this year',
    defaultW: 2, defaultH: 3, minW: 2, minH: 2,
  },
  {
    id: 'revenue_summary',
    label: 'Revenue Summary',
    icon: '',
    description: 'Monthly revenue and payment trends',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'cni_overview',
    label: 'CNI Program',
    icon: '',
    description: 'CNI job counts and status breakdown',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'upcoming_schedule',
    label: 'Upcoming Schedule',
    icon: '',
    description: 'Next 7 days of scheduled work',
    defaultW: 4, defaultH: 2, minW: 2, minH: 2,
  },
  {
    id: 'recent_messages',
    label: 'Recent Messages',
    icon: '',
    description: 'Latest messages and notifications',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'time_clock',
    label: 'Time Clock',
    icon: '',
    description: 'Who is clocked in right now',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'open_quotes',
    label: 'Open Quotes',
    icon: '',
    description: 'Quotes needing conversion to sales orders',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'open_pos',
    label: 'Open PO Balance',
    icon: '',
    description: 'Outstanding purchase order values',
    defaultW: 2, defaultH: 2, minW: 1, minH: 2,
  },
  {
    id: 'quick_actions',
    label: 'Quick Actions',
    icon: '',
    description: 'Shortcut buttons to common tasks',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'fleet_checkin',
    label: 'Fleet Check-In',
    icon: '',
    description: 'Recent vehicle check-ins and daily counts',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'graphics_production',
    label: 'Graphics Production',
    icon: '',
    description: 'Graphics job pipeline and status counts',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'in_shop_tracking',
    label: 'In-Shop Tracking',
    icon: '',
    description: 'Vehicles currently in-shop by status',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'vehicles',
    label: 'Vehicles',
    icon: '',
    description: 'Recent scanned vehicles and counts',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'estimates',
    label: 'Estimates',
    icon: '',
    description: 'Recent estimates and totals',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'customers',
    label: 'Customers',
    icon: '',
    description: 'Customer count and top spenders YTD',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'parts_catalog',
    label: 'Parts Catalog',
    icon: '',
    description: 'Upfit and graphic parts counts',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'photo_reviews',
    label: 'Photo Reviews',
    icon: '',
    description: 'Pending photo approvals and status',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'user_management',
    label: 'User Management',
    icon: '',
    description: 'Active users and pending approvals',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'vendor_payments',
    label: 'Vendor Payments',
    icon: '',
    description: 'Installer invoice status and payments',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'purchase_orders',
    label: 'Purchase Orders',
    icon: '',
    description: 'Open POs and recent orders',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: '',
    description: 'Export vehicle spreadsheets and reports',
    defaultW: 2, defaultH: 2, minW: 1, minH: 1,
  },
  {
    id: 'my_jobs',
    label: 'My Jobs',
    icon: '',
    description: 'Jobs assigned to you with status',
    defaultW: 2, defaultH: 2, minW: 1, minH: 2,
  },
  {
    id: 'sales_pipeline',
    label: 'Sales Pipeline',
    icon: '',
    description: 'Opportunity stages, deal count, and pipeline value',
    defaultW: 2, defaultH: 3, minW: 2, minH: 2,
  },
  {
    id: 'my_accounts',
    label: 'My Accounts — Active Jobs',
    icon: '',
    description: 'Active graphics and fleet jobs grouped by customer',
    defaultW: 2, defaultH: 3, minW: 2, minH: 2,
  },
];

export const WIDGET_MAP = Object.fromEntries(WIDGET_REGISTRY.map(w => [w.id, w]));

// Default widgets shown for new users (before any customization)
export const DEFAULT_WIDGET_IDS = [
  'open_pos', 'needs_attention', 'revenue_summary', 'active_jobs',
  'cni_overview', 'quick_actions', 'upcoming_schedule',
];

// Generate default layout for a set of widget IDs
export function generateDefaultLayout(widgetIds: string[]) {
  let x = 0;
  let y = 0;
  return widgetIds.map(id => {
    const def = WIDGET_MAP[id];
    if (!def) return null;
    const item = {
      i: id,
      x: x,
      y: y,
      w: def.defaultW,
      h: def.defaultH,
      minW: def.minW,
      minH: def.minH,
      maxW: def.maxW,
      maxH: def.maxH,
    };
    x += def.defaultW;
    if (x >= 4) { x = 0; y += def.defaultH; }
    return item;
  }).filter(Boolean);
}
