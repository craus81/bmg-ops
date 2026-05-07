'use client';

import { CSSProperties, ReactNode, ButtonHTMLAttributes, useState } from 'react';
import { theme } from '@/lib/theme';

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}

const sizeMap: Record<Size, CSSProperties> = {
  sm: { padding: '6px 12px', fontSize: '12px', borderRadius: '8px' },
  md: { padding: '10px 16px', fontSize: '13px', borderRadius: '10px' },
  lg: { padding: '14px 22px', fontSize: '15px', borderRadius: '12px' },
};

function variantStyles(v: Variant, hovered: boolean): CSSProperties {
  switch (v) {
    case 'primary':
      return {
        background: hovered ? '#d62a1a' : theme.orange,
        color: '#fff',
        border: 'none',
        boxShadow: hovered ? '0 4px 12px rgba(238,49,32,0.35)' : '0 2px 8px rgba(238,49,32,0.25)',
      };
    case 'secondary':
      return {
        background: hovered ? theme.cardHover : theme.card,
        color: theme.textPrimary,
        border: `1px solid ${theme.borderStrong}`,
      };
    case 'destructive':
      return {
        background: hovered ? '#dc2626' : theme.error,
        color: '#fff',
        border: 'none',
        boxShadow: hovered ? '0 4px 12px rgba(248,113,113,0.35)' : '0 2px 8px rgba(248,113,113,0.25)',
      };
    case 'ghost':
      return {
        background: hovered ? theme.subtleBg : 'transparent',
        color: theme.textPrimary,
        border: '1px solid transparent',
      };
  }
}

/**
 * FleetSuite-flavored button. Matches the bold/branded look already in the
 * app: orange primary, navy/borders for secondary, strong shadows on lifted
 * variants. Uses CSS variables from globals.css so it adapts to dark/light
 * theme automatically.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const isDisabled = disabled || loading;

  return (
    <button
      {...rest}
      disabled={isDisabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...sizeMap[size],
        ...variantStyles(variant, hovered && !isDisabled),
        fontWeight: 700,
        letterSpacing: '0.01em',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.55 : 1,
        transition: 'all 0.15s ease',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        width: fullWidth ? '100%' : undefined,
        fontFamily: 'inherit',
      }}
    >
      {loading && (
        <span
          aria-hidden="true"
          style={{
            width: '12px',
            height: '12px',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            opacity: 0.8,
          }}
        />
      )}
      {children}
    </button>
  );
}
