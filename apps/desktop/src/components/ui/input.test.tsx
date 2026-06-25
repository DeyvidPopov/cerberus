// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { attachKeystrokeCapture, KeystrokeRecorder } from '../../lib/keystroke';
import { Input } from './input';

describe('Input primitive — M6 keystroke-capture compatibility (M12 constraint)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('forwards its ref to the underlying real <input> DOM node', () => {
    let node: HTMLInputElement | null = null;
    render(
      <Input
        aria-label="pw"
        type="password"
        ref={(el) => {
          node = el;
        }}
      />,
    );
    expect(node).toBeInstanceOf(HTMLInputElement);
    expect((node as unknown as HTMLInputElement | null)?.type).toBe('password');
  });

  it('keystroke capture still fires on character input of the forwarded input', () => {
    let node: HTMLInputElement | null = null;
    render(
      <Input
        aria-label="pw"
        type="password"
        ref={(el) => {
          node = el;
        }}
      />,
    );
    const input = node as unknown as HTMLInputElement;
    const recorder = new KeystrokeRecorder();
    let t = 0;
    const detach = attachKeystrokeCapture(input, recorder, () => (t += 10));

    // A real character: keydown → input(insertText) → keyup. Capture is now gated on the
    // `input` event so modifier keys (which produce no `input`) are excluded.
    const char = (): void => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    };
    char();
    char();

    // Two keystrokes captured by POSITION via the shadcn Input — the M6 timing path
    // attaches to a real <input> exactly as before (no interception/debounce).
    expect(recorder.length).toBe(2);
    detach();
  });
});
