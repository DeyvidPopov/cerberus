// React hook wiring keystroke capture onto an input (Milestone 6).
//
// Returns a ref callback to put on the master-password input and `takeSample` to
// read the position-indexed vector after a successful login. The hook holds only
// timing (in the recorder); it never holds the password or any character.
import { useCallback, useRef } from 'react';

import { attachKeystrokeCapture, KeystrokeRecorder } from './keystroke';

export interface KeystrokeCapture {
  /** Ref callback for the input whose keystroke timing is captured. */
  inputRef: (element: HTMLInputElement | null) => void;
  /** Extract the captured feature vector (durations only) and reset, or null. */
  takeSample: () => number[] | null;
  /** Discard captured timing without extracting. */
  reset: () => void;
}

export function useKeystrokeCapture(): KeystrokeCapture {
  const recorderRef = useRef<KeystrokeRecorder>(new KeystrokeRecorder());
  const detachRef = useRef<(() => void) | null>(null);

  const inputRef = useCallback((element: HTMLInputElement | null): void => {
    detachRef.current?.();
    detachRef.current = null;
    if (element !== null) {
      detachRef.current = attachKeystrokeCapture(element, recorderRef.current);
    }
  }, []);

  const takeSample = useCallback((): number[] | null => {
    const vector = recorderRef.current.extract();
    recorderRef.current.reset();
    return vector;
  }, []);

  const reset = useCallback((): void => {
    recorderRef.current.reset();
  }, []);

  return { inputRef, takeSample, reset };
}
