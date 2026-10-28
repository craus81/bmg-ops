import { describe, expect, it, vi } from 'vitest';
import {
  currentClientFileDropTarget, onClientFileDropTargetsChange, registerClientFileDropTarget,
} from './pane-drop-targets';
import { dropLabel } from './split-screen';

describe('Client Files drop targets', () => {
  it('opens the Graphics Builder when no page takes drops', () => {
    expect(currentClientFileDropTarget()).toBeNull();
    expect(dropLabel(null)).toBe('Let go to open it in the Graphics Builder');
  });

  it('hands a drop to the last page registered, and lets go when it unmounts', () => {
    const job = { label: 'Let go to add it to this job', onDrop: vi.fn() };
    const estimate = { label: 'Let go to add it to this estimate', onDrop: vi.fn() };
    const offJob = registerClientFileDropTarget(job);
    const offEstimate = registerClientFileDropTarget(estimate);
    expect(currentClientFileDropTarget()).toBe(estimate);
    expect(dropLabel(currentClientFileDropTarget()?.label)).toBe('Let go to add it to this estimate');
    offEstimate();
    expect(currentClientFileDropTarget()).toBe(job);
    offJob();
    expect(currentClientFileDropTarget()).toBeNull();
  });

  it('tells PaneBridge when the target changes, so the label stays right', () => {
    const seen = vi.fn();
    const stop = onClientFileDropTargetsChange(seen);
    const off = registerClientFileDropTarget({ label: 'x', onDrop: () => {} });
    off();
    stop();
    registerClientFileDropTarget({ label: 'y', onDrop: () => {} })();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
