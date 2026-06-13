// In-session mouse-dynamics capture (Milestone 10, Part B; ADR-0013).
//
// THE PRIVACY RULE, enforced structurally (PROJECT.md §5): this module records only
// pointer COORDINATES + TIMESTAMPS + event kind (move / press / release). It never
// reads the event target, the element under the pointer, or any content — the probe
// event shape has no field that could carry one. A window is summarized into the
// fixed mouse feature vector via the SHARED extractor (one definition, client +
// server cannot drift), and only that aggregate is streamed — never the raw trail.
import {
  MIN_MOUSE_SAMPLES,
  MOUSE_WINDOW_SIZE,
  MOUSE_WINDOW_STEP,
  extractMouseWindowFeatures,
  type MouseSample,
} from '@cerberus/shared-types';

const defaultNow = (): number => performance.now();

/**
 * Accumulates pointer samples and emits a feature vector once per SLIDING window:
 * when the buffer reaches `windowSize` it extracts the window, then slides forward
 * by `step` (so consecutive windows overlap by windowSize − step and a spike is
 * caught within one step). Holds only timing/geometry — never content.
 */
export class MouseWindowAggregator {
  private buffer: MouseSample[] = [];

  constructor(
    private readonly windowSize: number = MOUSE_WINDOW_SIZE,
    private readonly step: number = MOUSE_WINDOW_STEP,
  ) {}

  /** Add one sample; return the window feature vector when one completes, else null. */
  add(sample: MouseSample): number[] | null {
    this.buffer.push(sample);
    if (this.buffer.length < this.windowSize) {
      return null;
    }
    const window = this.buffer.slice(0, this.windowSize);
    this.buffer = this.buffer.slice(this.step); // slide forward
    if (window.length < MIN_MOUSE_SAMPLES) {
      return null;
    }
    return extractMouseWindowFeatures(window);
  }

  /** Discard buffered samples (e.g. on lock / detach). */
  reset(): void {
    this.buffer = [];
  }
}

/** The minimal pointer-event shape this module reads: COORDINATES only, no content. */
export interface PointerProbeEvent {
  readonly clientX: number;
  readonly clientY: number;
}

/** A target the capture can attach to (the webview `window` satisfies this). */
export interface MouseCaptureTarget {
  addEventListener(type: 'mousemove' | 'mousedown' | 'mouseup', listener: (event: PointerProbeEvent) => void): void;
  removeEventListener(
    type: 'mousemove' | 'mousedown' | 'mouseup',
    listener: (event: PointerProbeEvent) => void,
  ): void;
}

/**
 * Attach mouse capture to a target, invoking `onWindow` with each completed window's
 * feature vector. Returns a detach function. The handlers read only `clientX/clientY`
 * and the clock — never the event target or any content (the privacy rule).
 */
export function attachMouseCapture(
  target: MouseCaptureTarget,
  onWindow: (features: number[]) => void,
  now: () => number = defaultNow,
): () => void {
  const aggregator = new MouseWindowAggregator();

  const push = (event: PointerProbeEvent, kind: MouseSample['kind']): void => {
    const features = aggregator.add({ x: event.clientX, y: event.clientY, t: now(), kind });
    if (features !== null) {
      onWindow(features);
    }
  };
  const onMove = (e: PointerProbeEvent): void => {
    push(e, 'move');
  };
  const onDown = (e: PointerProbeEvent): void => {
    push(e, 'down');
  };
  const onUp = (e: PointerProbeEvent): void => {
    push(e, 'up');
  };

  target.addEventListener('mousemove', onMove);
  target.addEventListener('mousedown', onDown);
  target.addEventListener('mouseup', onUp);
  return () => {
    target.removeEventListener('mousemove', onMove);
    target.removeEventListener('mousedown', onDown);
    target.removeEventListener('mouseup', onUp);
    aggregator.reset();
  };
}
