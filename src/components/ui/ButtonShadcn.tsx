'use client';

import { CSSProperties, ReactNode, ButtonHTMLAttributes, useState } from 'react';

/**
 * Approximates shadcn/ui's <Button> defaults using inline styles so we can
 * preview the aesthetic without first adding Tailwind. If we adopted shadcn
 * for real, we'd install Tailwind + Radix and use shadcn's actual component
 * (which would render the same look but via utility classes). The exposed
 * variant/size names match shadcn's API exactly so call sites would migrate
 * by deleting this file and pointing imports at the real component.
 */

type Variant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}

const sizeMap: Record<Size, CSSProperties> = {
  sm: { padding: '4px 12px', fontSize: '13px', height: '32px' },
  md: { padding: '8px 16px', fontSize: '14px', height: '36px' },
  lg: { padding: '8px 32px', fontSize: '14px', height: '40px' },
};

function variantStyles(v: Variant, hovered: boolean): CSSProperties {
  switch (v) {
    case 'default':
      return {
        background: hovered ? '#1a1a1a' : '#0a0a0a',
        color: '#fafafa',
        border: '1px solid transparent',
      };
    case 'secondary':
      return {
        background: hovered ? '#e5e5e5' : '#f5f5f5',
        color: '#0a0a0a',
        border: '1px solid transparent',
      };
    case 'destructive':
      return {
        background: hovered ? '#b91c1c' : '#dc2626',
        color: '#fafafa',
        border: '1px solid transparent',
      };
    case 'outline':
      return {
        background: hovered ? '#f5f5f5' : 'transparent',
        color: '#0a0a0a',
        border: '1px solid #e5e5e5',
      };
    case 'ghost':
      return {
        background: hovered ? '#f5f5f5' : 'transparent',
        color: '#0a0a0a',
        border: '1px solid transparent',
      };
  }
}

export function ButtonShadcn({
  variant = 'default',
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
        fontWeight: 500,
        borderRadius: '6px',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.5 : 1,
        transition: 'colors 0.15s ease',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        width: fullWidth ? '100%' : undefined,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
    >
      {loading && (
        <span
          aria-hidden="true"
          style={{
            width: '14px',
            height: '14px',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            opacity: 0.7,
          }}
        />
      )}
      {children}
    </button>
  );
}
