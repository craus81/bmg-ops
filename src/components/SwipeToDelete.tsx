'use client';

import { useRef, useState, useEffect, ReactNode } from 'react';

interface SwipeToDeleteProps {
  onDelete: () => void;
  confirmMessage?: string;
  children: ReactNode;
}

export default function SwipeToDelete({ onDelete, confirmMessage, children }: SwipeToDeleteProps) {
  const startX = useRef(0);
  const currentX = useRef(0);
  const [offset, setOffset] = useState(0);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(true); // default true to avoid flash
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
      if (!window.confirm(confirmMessage)) {
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
      style={{ position: 'relative', overflow: 'hidden', borderRadius: '10px' }}
      onMouseEnter={!isTouchDevice ? () => setHovered(true) : undefined}
      onMouseLeave={!isTouchDevice ? () => setHovered(false) : undefined}
    >
      {/* Swipe delete button behind (mobile) */}
      {isTouchDevice && (
        <div
          style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: '90px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#ef4444', borderRadius: '0 10px 10px 0',
            opacity: showDelete ? 1 : Math.min(1, Math.abs(offset) / 90),
          }}
        >
          <button
            onClick={handleDelete}
            style={{
              background: 'none', border: 'none', color: '#fff',
              fontWeight: 800, fontSize: '12px', padding: '8px 12px',
              cursor: 'pointer',
            }}
          >
            🗑 Delete
          </button>
        </div>
      )}

      {/* Main content - slides on mobile */}
      <div
        onTouchStart={isTouchDevice ? handleTouchStart : undefined}
        onTouchMove={isTouchDevice ? handleTouchMove : undefined}
        onTouchEnd={isTouchDevice ? handleTouchEnd : undefined}
        onClick={showDelete ? handleCancel : undefined}
        style={{
          transform: isTouchDevice ? `translateX(${offset}px)` : 'none',
          transition: offset === 0 || offset === -90 ? 'transform 0.2s ease' : 'none',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {children}
      </div>

      {/* Desktop delete button - appears on hover */}
      {!isTouchDevice && (
        <button
          onClick={(e) => { e.stopPropagation(); handleDelete(); }}
          style={{
            position: 'absolute', top: '10px', right: '10px', zIndex: 3,
            width: '30px', height: '30px', borderRadius: '7px',
            background: hovered ? 'rgba(239,68,68,0.15)' : 'transparent',
            border: hovered ? '1px solid rgba(239,68,68,0.3)' : '1px solid transparent',
            color: '#f87171', fontSize: '14px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: hovered ? 1 : 0,
            transition: 'opacity 0.15s, background 0.15s',
            pointerEvents: hovered ? 'auto' : 'none',
          }}
        >
          🗑
        </button>
      )}
    </div>
  );
}
