import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MOUSE_FEATURE_DIMENSION, type MouseSample } from '@cerberus/shared-types';
import { describe, expect, it } from 'vitest';

import { loadBalabitByUser, parseBalabitSession, windowizeSession } from './balabit-loader';
import { DEFAULT_MOUSE_EVALUATION_CONFIG, DEFAULT_MOUSE_WINDOW_CONFIG } from './config';
import { mahalanobisDetector } from './detectors';
import { runEvaluation } from './evaluation';

describe('parseBalabitSession', () => {
  it('maps rows to position-indexed samples (clicks vs movement, seconds → ms)', () => {
    const csv = [
      'record timestamp,client timestamp,button,state,x,y',
      '0.0,0.0,NoButton,Move,100,100',
      '0.1,0.1,Left,Pressed,100,100',
      '0.2,0.2,Left,Released,100,100',
      '0.3,0.3,NoButton,Drag,110,100',
      'garbage,row,should,be,dropped,here',
    ].join('\n');
    const samples = parseBalabitSession(csv);
    expect(samples).toHaveLength(4); // header + malformed row dropped
    expect(samples[0]).toEqual({ x: 100, y: 100, t: 0, kind: 'move' });
    expect(samples[1]?.kind).toBe('down'); // Pressed
    expect(samples[2]?.kind).toBe('up'); // Released
    expect(samples[3]?.kind).toBe('move'); // Drag
    expect(samples[1]?.t).toBeCloseTo(100, 6); // 0.1 s → 100 ms
  });
});

describe('windowizeSession', () => {
  it('produces fixed-dimension windows and respects the per-session cap', () => {
    const samples: MouseSample[] = Array.from({ length: 40 }, (_v, i) => ({
      x: i * 3,
      y: i,
      t: i * 16,
      kind: 'move',
    }));
    const windows = windowizeSession(samples, { windowSize: 4, windowStep: 4, maxWindowsPerSession: 6 });
    expect(windows.length).toBe(6); // 40/4 = 10 available, capped at 6
    for (const w of windows) {
      expect(w).toHaveLength(MOUSE_FEATURE_DIMENSION);
    }
  });

  it('non-overlapping (step == size) yields independent windows', () => {
    const samples: MouseSample[] = Array.from({ length: 12 }, (_v, i) => ({
      x: i,
      y: 0,
      t: i * 10,
      kind: 'move',
    }));
    expect(windowizeSession(samples, { windowSize: 4, windowStep: 4, maxWindowsPerSession: 100 })).toHaveLength(3);
  });
});

// --- Sanity + determinism against the REAL Balabit dataset. Gitignored (real
// human captures, PROJECT.md §5) and absent in hermetic CI, so skipped there. ---
const DATASET_DIR = fileURLToPath(new URL('../../../../docs/evaluation/data/balabit', import.meta.url));
const hasDataset = existsSync(`${DATASET_DIR}/training_files`);

describe('Balabit mouse benchmark — determinism + sanity bound', () => {
  it.skipIf(!hasDataset)(
    'is deterministic (seeded) and the mouse EER is in a plausible range',
    () => {
      const data = loadBalabitByUser(DATASET_DIR, DEFAULT_MOUSE_WINDOW_CONFIG);
      expect(data.size).toBe(10); // the 10 Balabit users
      expect(data.get([...data.keys()][0] ?? '')?.[0]).toHaveLength(MOUSE_FEATURE_DIMENSION);

      const first = runEvaluation(data, [mahalanobisDetector()], DEFAULT_MOUSE_EVALUATION_CONFIG);
      const second = runEvaluation(data, [mahalanobisDetector()], DEFAULT_MOUSE_EVALUATION_CONFIG);
      // Seeded ⇒ byte-identical reports on re-run (PROJECT.md §6).
      expect(JSON.stringify(second)).toEqual(JSON.stringify(first));

      const eer = first.detectors[0]?.meanEer ?? 0;
      // Mouse dynamics is noisy: per-window EER is far higher than keystroke. Flag
      // wildly-off numbers — below ~15% would be implausibly good for this feature
      // set; at/above 50% is no better than chance.
      expect(eer).toBeGreaterThan(0.15);
      expect(eer).toBeLessThan(0.5);
    },
    120_000,
  );

  it.skipIf(hasDataset)('(skipped — real Balabit dataset not present; see docs/evaluation/README.md)', () => {
    expect(hasDataset).toBe(false);
  });
});
