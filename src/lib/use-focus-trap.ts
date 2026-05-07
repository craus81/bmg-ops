'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Traps Tab/Shift+Tab focus inside the returned ref while `active` is true.
 * Wires Escape to call `onEscape` if provided. Restores focus to the
 * previously-focused element when `active` flips back to false.
 *
 * Usage:
 *   const modalRef = useFocusTrap<HTMLDivElement>(isOpen, () => setIsOpen(false));
 *   return isOpen ? <div ref={modalRef} role="dialog" aria-modal="true">…</div> : null;
 *
 * Without this, keyboard users tab past the modal into the page behind it,
 * which is a serious accessibility break (and confusing for sighted users
 * because the focus ring disappears off the modal).
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape?: () => void,
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active || !ref.current) return;
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the modal if it isn't already there.
    if (!node.contains(document.activeElement)) {
      const focusables = node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusables[0] || node).focus();
    }

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      // Restore focus to whatever opened the modal.
      previouslyFocused?.focus?.();
    };
  }, [active, onEscape]);

  return ref;
}
