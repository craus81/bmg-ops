'use client';

import { useState } from 'react';

// Drop-in <input type="number"> for fields backed by numeric state. A plain
// controlled input re-renders the coerced state on every keystroke, so when
// onChange maps '' back to a number (parseFloat(v) || 0, Math.max(1, …), an
// ignored-if-invalid update), the prepopulated 0 reappears the instant it's
// deleted and the field can never be cleared. While focused this input shows
// exactly what was typed — every change still goes to onChange, so state
// stays live for totals/submits — and on blur it snaps back to the
// coerced/clamped state value.
type NumberInputProps = Omit<React.ComponentProps<'input'>, 'type'>;

export default function NumberInput({ value, onChange, onFocus, onBlur, ...rest }: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="number"
      value={draft ?? value ?? ''}
      onFocus={e => { setDraft(e.target.value); onFocus?.(e); }}
      onChange={e => { setDraft(e.target.value); onChange?.(e); }}
      onBlur={e => { setDraft(null); onBlur?.(e); }}
    />
  );
}
