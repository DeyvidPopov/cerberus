import { describe, expect, it } from 'vitest';

import {
  KeystrokeRecorder,
  attachKeystrokeCapture,
  type InputProbeEvent,
  type KeystrokeCaptureTarget,
  type KeystrokeProbeEvent,
} from './keystroke';

type AnyProbe = KeystrokeProbeEvent & InputProbeEvent;

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

  it('drops the trailing submit key (Enter keydown with no keyup) and still extracts', () => {
    // Type 3 keys (all released), then press Enter to submit: the Enter keydown is
    // recorded but its keyup has NOT fired when the synchronous submit handler reads
    // the sample. The trailing incomplete keydown must be dropped, not discard the
    // whole sample (the M6→demo enrollment-freeze bug).
    const r = new KeystrokeRecorder();
    r.recordDown(100);
    r.recordUp(180);
    r.recordDown(200);
    r.recordUp(260);
    r.recordDown(300);
    r.recordUp(400);
    r.recordDown(450); // Enter keydown — no keyup yet
    // Same vector as the 3 complete keys; the trailing Enter is ignored.
    expect(r.extract()).toEqual([80, 60, 100, 100, 100, 20, 40]);
  });

  it('yields the SAME dimension whether submitted by click or by Enter (stable enrollment dim)', () => {
    // Click: 5 complete keys → dimension 3·5−2 = 13.
    const click = new KeystrokeRecorder();
    for (let i = 0; i < 5; i += 1) {
      click.recordDown(i * 100);
      click.recordUp(i * 100 + 50);
    }
    // Enter: the same 5 keys, then a trailing Enter keydown (no keyup).
    const enter = new KeystrokeRecorder();
    for (let i = 0; i < 5; i += 1) {
      enter.recordDown(i * 100);
      enter.recordUp(i * 100 + 50);
    }
    enter.recordDown(600); // Enter keydown
    const clickVec = click.extract();
    const enterVec = enter.extract();
    expect(clickVec).not.toBeNull();
    expect(enterVec).not.toBeNull();
    expect(enterVec?.length).toBe(clickVec?.length);
    expect(enterVec?.length).toBe(13);
    // Identical samples ⇒ the server buffers both (no dimension_mismatch drop).
    expect(enterVec).toEqual(clickVec);
  });

  it('accepts EXACTLY the minimum complete keys followed by a trailing submit key (boundary)', () => {
    // 2 complete keys (= MIN_KEYSTROKES) + a trailing Enter keydown ⇒ a valid dim-4
    // vector (3·2−2). Pins the lower boundary so a `<`→`<=` regression is caught.
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(40);
    r.recordDown(100);
    r.recordUp(150);
    r.recordDown(200); // Enter keydown — no keyup
    const v = r.extract();
    expect(v).not.toBeNull();
    expect(v?.length).toBe(4);
  });

  it('still returns null when too few COMPLETE keys remain after dropping the trailing key', () => {
    // One complete key + a trailing unreleased key ⇒ only 1 complete (< MIN_KEYSTROKES).
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(50);
    r.recordDown(100); // never released
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
// adversarial events (keydown/keyup AND input).
class FakeInput implements KeystrokeCaptureTarget {
  private handlers = new Map<string, ((event: AnyProbe) => void)[]>();

  addEventListener(type: 'keydown' | 'keyup' | 'input', listener: (event: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener as (event: AnyProbe) => void);
    this.handlers.set(type, list);
  }

  removeEventListener(type: 'keydown' | 'keyup' | 'input', listener: (event: never) => void): void {
    const list = this.handlers.get(type);
    if (list) {
      this.handlers.set(
        type,
        list.filter((h) => h !== (listener as (event: AnyProbe) => void)),
      );
    }
  }

  dispatch(type: 'keydown' | 'keyup' | 'input', event: AnyProbe): void {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }

  /** Type one character: keydown → input(insertText) → keyup. */
  char(): void {
    this.dispatch('keydown', { repeat: false });
    this.dispatch('input', { inputType: 'insertText' });
    this.dispatch('keyup', { repeat: false });
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
  it('records one keystroke per committed character (input-gated) with monotonic timestamps', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    const clock = [100, 180, 200, 260]; // consumed at keydown + keyup only (not input)
    let i = 0;
    const detach = attachKeystrokeCapture(input, recorder, () => clock[i++] ?? 0);

    input.char(); // down 100, input, up 180
    input.char(); // down 200, input, up 260

    // holds 80/60 ; DD 200-100=100 ; UD 200-180=20
    expect(recorder.extract()).toEqual([80, 60, 100, 20]);
    detach();
    expect(input.listenerCount()).toBe(0);
  });

  it('EXCLUDES modifier keydowns (Shift) — only committed characters count, dimension stable', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    attachKeystrokeCapture(input, recorder, () => 1);

    // Shift+S then a: Shift down, S down, input(S), S up, Shift up, a down, input(a), a up.
    input.dispatch('keydown', { repeat: false }); // Shift down (no input follows it)
    input.dispatch('keydown', { repeat: false }); // S down
    input.dispatch('input', { inputType: 'insertText' }); // S committed
    input.dispatch('keyup', { repeat: false });
    input.dispatch('keyup', { repeat: false }); // Shift up (stray)
    input.char(); // a

    expect(recorder.length).toBe(2); // S + a — Shift excluded
  });

  it('TAINTS the sample on a paste (insertFromPaste) → extract returns null', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    attachKeystrokeCapture(input, recorder, () => 1);
    input.char();
    input.char();
    input.dispatch('keydown', { repeat: false });
    input.dispatch('input', { inputType: 'insertFromPaste' }); // pasted the rest
    expect(recorder.extract()).toBeNull();
  });

  it('TAINTS the sample on a correction (deleteContentBackward) → extract returns null', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    attachKeystrokeCapture(input, recorder, () => 1);
    input.char();
    input.char();
    input.dispatch('input', { inputType: 'deleteContentBackward' }); // backspace
    expect(recorder.extract()).toBeNull();
  });

  it('ignores auto-repeat keydowns', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    let t = 0;
    attachKeystrokeCapture(input, recorder, () => (t += 10));

    input.dispatch('keydown', { repeat: false });
    input.dispatch('keydown', { repeat: true }); // auto-repeat: must be dropped
    input.dispatch('input', { inputType: 'insertText' });
    input.dispatch('keyup', { repeat: false });
    input.char();

    expect(recorder.length).toBe(2); // not 3
  });

  it('PRIVACY: the handler never reads character identity (key/code/keyCode/data throw if touched)', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    attachKeystrokeCapture(input, recorder, () => 1);

    // keydown/keyup whose key/code/keyCode getters THROW, and an input whose `data` getter
    // THROWS — the capture must read only `repeat` and `inputType`, never identity/content.
    const keyTrap = {
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
    } as unknown as AnyProbe;
    const inputTrap = {
      inputType: 'insertText',
      get data(): string {
        throw new Error('typed character was accessed — PRIVACY VIOLATION');
      },
    } as unknown as AnyProbe;

    expect(() => {
      input.dispatch('keydown', keyTrap);
      input.dispatch('input', inputTrap);
      input.dispatch('keyup', keyTrap);
      input.dispatch('keydown', keyTrap);
      input.dispatch('input', inputTrap);
      input.dispatch('keyup', keyTrap);
    }).not.toThrow();
    expect(recorder.length).toBe(2); // timing still captured, identity/content untouched
  });
});
