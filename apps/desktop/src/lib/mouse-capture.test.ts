import { MOUSE_FEATURE_DIMENSION, type MouseSample } from '@cerberus/shared-types';
import { describe, expect, it, vi } from 'vitest';

import {
  attachMouseCapture,
  MouseWindowAggregator,
  type MouseCaptureTarget,
  type PointerProbeEvent,
} from './mouse-capture';

describe('MouseWindowAggregator', () => {
  it('emits a fixed-dimension vector once the window fills, then slides by step', () => {
    const agg = new MouseWindowAggregator(4, 2);
    const sample = (i: number): MouseSample => ({ x: i * 5, y: i, t: i * 20, kind: 'move' });

    expect(agg.add(sample(0))).toBeNull();
    expect(agg.add(sample(1))).toBeNull();
    expect(agg.add(sample(2))).toBeNull();
    const first = agg.add(sample(3)); // window of 4 completes
    expect(first).not.toBeNull();
    expect(first).toHaveLength(MOUSE_FEATURE_DIMENSION);

    // After sliding by 2, the next window completes after 2 more samples.
    expect(agg.add(sample(4))).toBeNull();
    expect(agg.add(sample(5))).not.toBeNull();
  });

  it('reset discards the partial buffer', () => {
    const agg = new MouseWindowAggregator(3, 1);
    agg.add({ x: 0, y: 0, t: 0, kind: 'move' });
    agg.add({ x: 1, y: 0, t: 10, kind: 'move' });
    agg.reset();
    // Buffer cleared → needs a full window again before emitting.
    expect(agg.add({ x: 2, y: 0, t: 20, kind: 'move' })).toBeNull();
    expect(agg.add({ x: 3, y: 0, t: 30, kind: 'move' })).toBeNull();
    expect(agg.add({ x: 4, y: 0, t: 40, kind: 'move' })).not.toBeNull();
  });
});

interface FakeTarget extends MouseCaptureTarget {
  fire: (type: 'mousemove' | 'mousedown' | 'mouseup', event: PointerProbeEvent) => void;
  count: () => number;
}

function fakeTarget(): FakeTarget {
  const listeners = new Map<string, ((event: PointerProbeEvent) => void)[]>();
  return {
    addEventListener(type, listener) {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
    fire(type, event) {
      for (const l of listeners.get(type) ?? []) {
        l(event);
      }
    },
    count() {
      let n = 0;
      for (const arr of listeners.values()) {
        n += arr.length;
      }
      return n;
    },
  };
}

describe('attachMouseCapture', () => {
  it('reads only pointer coordinates + clock and emits a window vector', () => {
    const target = fakeTarget();
    const onWindow = vi.fn();
    let clock = 0;
    const now = (): number => (clock += 16);

    const detach = attachMouseCapture(target, onWindow, now);
    // A default window is MOUSE_WINDOW_SIZE moves; fire enough to complete one.
    for (let i = 0; i < 40; i += 1) {
      target.fire('mousemove', { clientX: i * 3, clientY: i });
    }
    expect(onWindow).toHaveBeenCalled();
    const vector = onWindow.mock.calls[0]?.[0] as number[];
    expect(vector).toHaveLength(MOUSE_FEATURE_DIMENSION);

    detach();
    expect(target.count()).toBe(0); // listeners removed
  });
});
