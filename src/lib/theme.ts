// BMG Theme — CSS variable references
// All actual values live in globals.css
// These are just typed references for inline styles

export const theme = {
  navy: 'var(--navy)',
  navyLight: 'var(--navy-light)',
  orange: 'var(--orange)',
  orangeGlow: 'var(--orange-glow)',
  orangeSoft: 'var(--orange-soft)',

  bg: 'var(--bg)',
  card: 'var(--card)',
  cardHover: 'var(--card-hover)',
  headerBg: 'var(--header-bg)',
  navBg: 'var(--nav-bg)',
  inputBg: 'var(--input-bg)',

  border: 'var(--border)',
  borderStrong: 'var(--border-strong)',

  textPrimary: 'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  textMuted: 'var(--text-muted)',

  success: 'var(--success)',
  successBg: 'var(--success-bg)',
  successBorder: 'var(--success-border)',
  warning: 'var(--warning)',
  warningBg: 'var(--warning-bg)',
  warningBorder: 'var(--warning-border)',
  error: 'var(--error)',
  errorBg: 'var(--error-bg)',
  errorBorder: 'var(--error-border)',

  shadowSm: 'var(--shadow-sm)',
  shadowMd: 'var(--shadow-md)',

  progressTrack: 'var(--progress-track)',
  subtleBg: 'var(--subtle-bg)',
  overlay: 'var(--overlay)',

  tabActiveBg: 'var(--tab-active-bg)',
  tabActiveBorder: 'var(--tab-active-border)',
  tabActiveColor: 'var(--tab-active-color)',
} as const;
