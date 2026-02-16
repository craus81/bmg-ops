// BMG Brand Theme
// Colors extracted from BMG Fleet logo

export const theme = {
  // Primary brand colors
  navy: '#1e4a5e',        // Dark navy from logo text
  navyLight: '#2a6178',   // Lighter navy for hover states
  navyDark: '#153a4b',    // Darker navy for depth
  orange: '#ee3120',      // Orange-red accent from logo
  orangeLight: '#f15648', // Lighter orange for hover
  orangeDark: '#c82818',  // Darker orange for pressed

  // Neutrals (light theme)
  white: '#ffffff',
  gray50: '#f7f8f9',      // Lightest gray - page background
  gray100: '#eef1f3',     // Light gray - card backgrounds
  gray200: '#dce2e6',     // Borders
  gray300: '#b0bfc6',     // From logo anti-aliasing
  gray400: '#8899a4',     // Muted text
  gray500: '#6b7a84',     // Secondary text
  gray600: '#4a5f6a',     // Body text
  gray700: '#2d4450',     // Headings
  gray800: '#1a3340',     // Dark text
  gray900: '#0f2230',     // Darkest

  // Semantic
  success: '#16a34a',
  successBg: 'rgba(22,163,74,0.08)',
  successBorder: 'rgba(22,163,74,0.2)',
  warning: '#d97706',
  warningBg: 'rgba(217,119,6,0.08)',
  warningBorder: 'rgba(217,119,6,0.2)',
  error: '#dc2626',
  errorBg: 'rgba(220,38,38,0.06)',
  errorBorder: 'rgba(220,38,38,0.2)',

  // UI
  cardBg: '#ffffff',
  cardBorder: '#dce2e6',
  inputBg: '#f7f8f9',
  inputBorder: '#dce2e6',
  headerBg: '#1e4a5e',
  navBg: '#ffffff',
  pageBg: '#f0f2f4',
} as const;
