'use client';

import { useRef, useState, useEffect, ReactNode } from 'react';
import { useDialog } from '@/components/DialogProvider';

interface SwipeToDeleteProps {
  onDelete: () => void;
  confirmMessage?: string;
  children: ReactNode;
}

export default function SwipeToDelete({ onDelete, confirmMessage, children }: SwipeToDeleteProps) {
  const dialog = useDialog();
  const startX = useRef(0);
  const currentX = useRef(0);
  const [offset, setOffset] = useState(0);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(true);
  const [hovered, setHovered] = useState(false);
  const threshold = -75;

  useEffect(() => {
    setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    currentX.current = offset;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const diff = e.touches[0].clientX - startX.current;
    const newOffset = Math.min(0, Math.max(-90, currentX.current + diff));
    setOffset(newOffset);
  };

  const handleTouchEnd = () => {
    if (offset < threshold) {
      setOffset(-90);
      setShowDelete(true);
    } else {
      setOffset(0);
      setShowDelete(false);
    }
  };

  const handleDelete = async () => {
    if (confirmMessage) {
      if (!(await dialog.confirm(confirmMessage, { destructive: true, confirmLabel: 'Delete' }))) {
        setOffset(0);
        setShowDelete(false);
        return;
      }
    }
    setDeleting(true);
    await onDelete();
  };

  const handleCancel = () => {
    setOffset(0);
    setShowDelete(false);
  };

  if (deleting) return null;

  return (
    <div
      style={{ position: 'relative', overflow: 'hidden', borderRadius: '12px' }}
      onMouseEnter={!isTouchDevice ? () => setHovered(true) : undefined}
      onMouseLeave={!isTouchDevice ? () => setHovered(false) : undefined}
    >
      {isTouchDevice && (
        <div
          style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: '90px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#dc2626', borderRadius: '0 12px 12px 0',
            opacity: showDelete ? 1 : Math.min(1, Math.abs(offset) / 90),
          }}
        >
          <button
            onClick={handleDelete}
            style={{ background: 'none', border: 'none', color: '#fff', fontWeight: 800, fontSize: '12px', padding: '8px 12px', cursor: 'pointer' }}
          >
            Delete
          </button>
        </div>
      )}

      <div
        onTouchStart={isTouchDevice ? handleTouchStart : undefined}
        onTouchMove={isTouchDevice ? handleTouchMove : undefined}
        onTouchEnd={isTouchDevice ? handleTouchEnd : undefined}
        onClick={showDelete ? handleCancel : undefined}
        style={{
          transform: isTouchDevice ? `translateX(${offset}px)` : 'none',
          transition: offset === 0 || offset === -90 ? 'transform 0.2s ease' : 'none',
          position: 'relative', zIndex: 1,
        }}
      >
        {children}
      </div>

      {!isTouchDevice && (
        <button
          onClick={(e) => { e.stopPropagation(); handleDelete(); }}
          style={{
            position: 'absolute', top: '10px', right: '10px', zIndex: 3,
            width: '30px', height: '30px', borderRadius: '7px',
            background: hovered ? 'rgba(220,38,38,0.08)' : 'transparent',
            border: hovered ? '1px solid rgba(220,38,38,0.2)' : '1px solid transparent',
            color: '#dc2626', fontSize: '14px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: hovered ? 1 : 0,
            transition: 'opacity 0.15s, background 0.15s',
            pointerEvents: hovered ? 'auto' : 'none',
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
