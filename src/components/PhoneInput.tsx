'use client';

/**
 * Phone input that formats US numbers as you type — (555) 123-4567 —
 * while keeping the caret anchored to the digit being edited (naive
 * reformat-on-change snaps the caret to the end on mid-string edits).
 * International numbers, extensions, and letters pass through untouched;
 * see formatPhoneInput in src/lib/utils.ts for the rules.
 *
 * Drop-in for a bare <input>: same style/placeholder/etc. props, but
 * onChange receives the formatted string, not the event.
 */

import { useRef, type InputHTMLAttributes } from 'react';
import { formatPhoneInput } from '@/lib/utils';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
};

export default function PhoneInput({ value, onChange, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <input
      {...rest}
      ref={ref}
      type="tel"
      value={value}
      onChange={(e) => {
        const el = e.target;
        const raw = el.value;
        const formatted = formatPhoneInput(raw);
        // Count digits left of the caret in the raw value, then place the
        // caret after that many digits in the formatted value.
        const digitsBefore = raw.slice(0, el.selectionStart ?? raw.length).replace(/\D/g, '').length;
        onChange(formatted);
        if (formatted !== raw) {
          requestAnimationFrame(() => {
            const node = ref.current;
            if (!node || document.activeElement !== node) return;
            let pos = 0, seen = 0;
            while (pos < formatted.length && seen < digitsBefore) {
              if (/\d/.test(formatted[pos])) seen++;
              pos++;
            }
            node.setSelectionRange(pos, pos);
          });
        }
      }}
    />
  );
}
