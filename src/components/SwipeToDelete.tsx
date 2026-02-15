'use client';

import { useRef, useState, ReactNode } from 'react';

interface SwipeToDeleteProps {
  onDelete: () => void;
  confirmMessage?: string; // If set, shows confirm dialog before deleting
  children: ReactNode;
}

export default function SwipeToDelete({ onDelete, confirmMessage, children }: SwipeToDeleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const [offset, setOffset] = useState(0);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const threshold = -75;

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
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: '10px' }}>
      {/* Delete button behind */}
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

      {/* Main content - slides left */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={showDelete ? handleCancel : undefined}
        style={{
          transform: `translateX(${offset}px)`,
          transition: offset === 0 || offset === -90 ? 'transform 0.2s ease' : 'none',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}
