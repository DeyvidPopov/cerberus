// Position-indexed keystroke capture (Milestone 6). ADR-0002, ADR-0009.
//
// THE PRIVACY RULE, enforced structurally: this module records only event TYPE
// (keydown vs keyup, via separate listeners) and TIMESTAMPS. It never reads
// `event.key`, `event.code`, `event.keyCode`, or any character identity — the
// recorder's API has no parameter that could carry one. The master password
// flows ONLY to the Rust crypto core (unchanged); this timing path is separate
// and produces durations alone.
import { extractFeatureVector, MIN_KEYSTROKES, type KeystrokeTiming } from '@cerberus/shared-types';

const defaultNow = (): number => performance.now();

interface Entry {
  down: number;
  up: number | null;
}

/**
 * Accumulates keydown/keyup TIMESTAMPS by keystroke position and extracts the
 * position-indexed feature vector. Keyups are matched to keydowns in FIFO press
 * order (correct for deliberate password entry; under rare nested-release
 * rollover the attribution is approximate — documented in ADR-0009). No method
 * accepts a key or character: identity cannot enter here.
 */
export class KeystrokeRecorder {
  private entries: Entry[] = [];
  private pending: number[] = [];
  /** Set when the attempt can't yield a clean typing rhythm (a paste, or a mid-word
   *  correction); `extract()` then returns null so no garbage sample is sent. */
  private tainted = false;

  /** Record a keydown at `timestamp` (ms). Advances the position counter. */
  recordDown(timestamp: number): void {
    const position = this.entries.length;
    this.entries.push({ down: timestamp, up: null });
    this.pending.push(position);
  }

  /** Record a keyup at `timestamp` (ms), matched to the oldest unreleased keydown. */
  recordUp(timestamp: number): void {
    const position = this.pending.shift();
    if (position === undefined) {
      return; // stray keyup (e.g. a key pressed before capture began)
    }
    const entry = this.entries[position];
    if (entry !== undefined) {
      entry.up = timestamp;
    }
  }

  /** Discard all captured timing (call between attempts / on field clear). */
  reset(): void {
    this.entries = [];
    this.pending = [];
    this.tainted = false;
  }

  /** Mark this attempt unusable (a paste or a correction) — `extract()` returns null. */
  markTainted(): void {
    this.tainted = true;
  }

  /** Number of keydowns captured so far. */
  get length(): number {
    return this.entries.length;
  }

  /**
   * Whether enough keystrokes are captured and ALL have been released. Note this is
   * STRICTER than `extract()`, which additionally tolerates a trailing unreleased
   * keydown (the submit/Enter key — see `extract`). To ask "is there an extractable
   * sample?", use `extract() !== null`, not this predicate.
   */
  isComplete(): boolean {
    return this.entries.length >= MIN_KEYSTROKES && this.entries.every((e) => e.up !== null);
  }

  /**
   * Extract the position-indexed feature vector (durations only), or null if the
   * capture is incomplete (too few keys, or a key never released).
   *
   * A TRAILING run of never-released keydowns is dropped first. This is what makes
   * "press Enter to log in" work: the submit key (Enter/Return) is captured as a
   * keydown, but the form's onSubmit handler reads the sample SYNCHRONOUSLY during
   * that keydown — before the matching keyup fires — so the Enter would otherwise
   * leave the capture "incomplete" and discard the entire (otherwise valid)
   * password sample, sending NO enrollment telemetry and freezing the baseline.
   * The submit key is not a password character; dropping it also keeps the vector
   * dimension stable (= password length) whether the user clicks or presses Enter,
   * so consecutive samples buffer instead of being rejected as dimension changes.
   * We never test key identity (the privacy rule, enforced by KeystrokeProbeEvent);
   * the submit key is recognised structurally — a trailing keydown with no keyup.
   */
  extract(): number[] | null {
    if (this.tainted) {
      return null; // a paste / correction happened — not a clean rhythm
    }
    let end = this.entries.length;
    while (end > 0 && this.entries[end - 1]?.up === null) {
      end -= 1;
    }
    if (end < MIN_KEYSTROKES) {
      return null;
    }
    const timings: KeystrokeTiming[] = [];
    for (let i = 0; i < end; i += 1) {
      const entry = this.entries[i];
      if (entry === undefined || entry.up === null) {
        // A mid-sequence key never released — the timing is unreliable; bail.
        return null;
      }
      timings.push({ down: entry.down, up: entry.up });
    }
    return extractFeatureVector(timings);
  }
}

/**
 * The minimal keydown/keyup shape this module reads: ONLY `repeat` (to drop key-repeat
 * keydowns), and it is optional. No `key`/`code`/`keyCode` — by construction the capture
 * handler cannot observe character identity. `readonly repeat?: boolean` makes a real DOM
 * `KeyboardEvent` structurally assignable here.
 */
export interface KeystrokeProbeEvent {
  readonly repeat?: boolean;
}

/**
 * The minimal `input` shape this module reads: ONLY `inputType` — the KIND of edit
 * ('insertText', 'deleteContentBackward', 'insertFromPaste', …), NEVER `data` (which would
 * carry the typed character). Used to count a keystroke only when a character is actually
 * committed (so modifier keys — Shift/Ctrl/Alt — are excluded and the vector dimension is
 * stable) and to reject pastes/corrections.
 */
export interface InputProbeEvent {
  readonly inputType?: string;
}

/** A target the capture can attach to (a real `HTMLInputElement` satisfies this). */
export interface KeystrokeCaptureTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: (event: KeystrokeProbeEvent) => void): void;
  addEventListener(type: 'input', listener: (event: InputProbeEvent) => void): void;
  removeEventListener(type: 'keydown' | 'keyup', listener: (event: KeystrokeProbeEvent) => void): void;
  removeEventListener(type: 'input', listener: (event: InputProbeEvent) => void): void;
}

/**
 * Attach character-keystroke capture to an input. Returns a detach function.
 *
 * A keystroke is counted only when an `input` event confirms a CHARACTER was committed —
 * a keydown's timestamp is buffered and recorded ONLY if the following `input` is an
 * insertion. This excludes modifier keys (Shift/Ctrl/Alt produce a keydown but no `input`),
 * so the vector dimension is exactly the number of characters and is STABLE across attempts
 * (a mixed-case password no longer drifts in dimension). A paste (`insertFromPaste`) or a
 * correction (`delete…`) TAINTS the attempt — you can't capture a typing rhythm from a
 * paste, and a mid-word edit makes the timing unusable — so `extract()` returns null and no
 * garbage sample is sent. The handlers read only `event.repeat`, `event.inputType`, and the
 * clock — never the typed character (no `key`/`code`/`keyCode`/`data`).
 */
export function attachKeystrokeCapture(
  target: KeystrokeCaptureTarget,
  recorder: KeystrokeRecorder,
  now: () => number = defaultNow,
): () => void {
  let pendingDown: number | null = null; // last keydown not yet confirmed by an `input`
  const onDown = (event: KeystrokeProbeEvent): void => {
    if (event.repeat === true) {
      return; // ignore auto-repeat; it is not a fresh keystroke
    }
    pendingDown = now(); // buffer; only confirmed if a character is produced
  };
  const onInput = (event: InputProbeEvent): void => {
    const type = event.inputType;
    if (type === 'insertFromPaste' || type === 'insertFromDrop') {
      recorder.markTainted(); // a paste can't yield a typing rhythm
      pendingDown = null;
      return;
    }
    if (typeof type === 'string' && type.startsWith('delete')) {
      recorder.markTainted(); // a correction makes the per-position timing unusable
      pendingDown = null;
      return;
    }
    if (pendingDown !== null) {
      recorder.recordDown(pendingDown); // a character was committed → count this keystroke
      pendingDown = null;
    }
  };
  const onUp = (): void => {
    recorder.recordUp(now());
  };
  target.addEventListener('keydown', onDown);
  target.addEventListener('input', onInput);
  target.addEventListener('keyup', onUp);
  return () => {
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('input', onInput);
    target.removeEventListener('keyup', onUp);
  };
}
