import { describe, expect, it } from 'vitest';

import {
  KeystrokeRecorder,
  attachKeystrokeCapture,
  type KeystrokeCaptureTarget,
  type KeystrokeProbeEvent,
} from './keystroke';

describe('KeystrokeRecorder — position-indexed timing', () => {
  it('extracts the correct vector from down/up events', () => {
    const r = new KeystrokeRecorder();
    // Three keys: downs 100/200/300, ups 180/260/400.
    r.recordDown(100);
    r.recordUp(180);
    r.recordDown(200);
    r.recordUp(260);
    r.recordDown(300);
    r.recordUp(400);
    // holds 80/60/100 ; DD 100/100 ; UD 20/40
    expect(r.extract()).toEqual([80, 60, 100, 100, 100, 20, 40]);
  });

  it('matches keyups to keydowns in FIFO order under release-ordered rollover', () => {
    const r = new KeystrokeRecorder();
    // key0 down 100, key1 down 190 (before key0 up), key0 up 200, key1 up 250.
    r.recordDown(100);
    r.recordDown(190);
    r.recordUp(200); // → key0
    r.recordUp(250); // → key1
    // holds: 100, 60 ; DD: 90 ; UD: 190-200 = -10
    expect(r.extract()).toEqual([100, 60, 90, -10]);
  });

  it('returns null while capture is incomplete (a key not yet released)', () => {
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(50);
    r.recordDown(100); // never released
    expect(r.isComplete()).toBe(false);
    expect(r.extract()).toBeNull();
  });

  it('reset() discards captured timing', () => {
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(10);
    r.recordDown(20);
    r.recordUp(30);
    r.reset();
    expect(r.length).toBe(0);
    expect(r.extract()).toBeNull();
  });

  it('PRIVACY: the extracted vector is numbers only — no character identity', () => {
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(10);
    r.recordDown(20);
    r.recordUp(30);
    const v = r.extract();
    expect(v).not.toBeNull();
    expect(v?.every((x) => typeof x === 'number')).toBe(true);
  });
});

// A fake event target that lets us drive the capture handlers directly and feed
// adversarial events.
class FakeInput implements KeystrokeCaptureTarget {
  private handlers = new Map<string, ((event: KeystrokeProbeEvent) => void)[]>();

  addEventListener(type: 'keydown' | 'keyup', listener: (event: KeystrokeProbeEvent) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener);
    this.handlers.set(type, list);
  }

  removeEventListener(
    type: 'keydown' | 'keyup',
    listener: (event: KeystrokeProbeEvent) => void,
  ): void {
    const list = this.handlers.get(type);
    if (list) {
      this.handlers.set(
        type,
        list.filter((h) => h !== listener),
      );
    }
  }

  dispatch(type: 'keydown' | 'keyup', event: KeystrokeProbeEvent): void {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }

  listenerCount(): number {
    let total = 0;
    for (const list of this.handlers.values()) {
      total += list.length;
    }
    return total;
  }
}

describe('attachKeystrokeCapture — DOM wiring', () => {
  it('feeds timestamps from a monotonic clock into the recorder', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    const clock = [100, 180, 200, 260];
    let i = 0;
    const detach = attachKeystrokeCapture(input, recorder, () => clock[i++] ?? 0);

    input.dispatch('keydown', { repeat: false });
    input.dispatch('keyup', { repeat: false });
    input.dispatch('keydown', { repeat: false });
    input.dispatch('keyup', { repeat: false });

    // holds 80/60 ; DD 200-100=100 ; UD 200-180=20
    expect(recorder.extract()).toEqual([80, 60, 100, 20]);
    detach();
    expect(input.listenerCount()).toBe(0);
  });

  it('ignores auto-repeat keydowns', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    let t = 0;
    attachKeystrokeCapture(input, recorder, () => (t += 10));

    input.dispatch('keydown', { repeat: false });
    input.dispatch('keydown', { repeat: true }); // auto-repeat: must be dropped
    input.dispatch('keyup', { repeat: false });
    input.dispatch('keydown', { repeat: false });
    input.dispatch('keyup', { repeat: false });

    expect(recorder.length).toBe(2); // not 3
  });

  it('PRIVACY: the handler never reads character identity (proven by a throwing getter)', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    attachKeystrokeCapture(input, recorder, () => 1);

    // An event whose key/code/keyCode getters THROW if accessed. The capture must
    // not touch them — if it did, dispatch would throw.
    const trap = {
      repeat: false,
      get key(): string {
        throw new Error('key identity was accessed — PRIVACY VIOLATION');
      },
      get code(): string {
        throw new Error('code identity was accessed — PRIVACY VIOLATION');
      },
      get keyCode(): number {
        throw new Error('keyCode identity was accessed — PRIVACY VIOLATION');
      },
    } as unknown as KeystrokeProbeEvent;

    expect(() => {
      input.dispatch('keydown', trap);
      input.dispatch('keyup', trap);
      input.dispatch('keydown', trap);
      input.dispatch('keyup', trap);
    }).not.toThrow();
    expect(recorder.length).toBe(2); // timing still captured, identity untouched
  });
});
