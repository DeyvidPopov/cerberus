// Balabit Mouse Dynamics Challenge loader (M11 / ADR-0014; PROJECT.md §5, §6).
//
// The mouse analogue of the CMU keystroke loader: it runs the SAME deployed M10
// mouse feature extractor (`extractMouseWindowFeatures`, @cerberus/shared-types)
// over the public benchmark, so the reported FAR/FRR/EER describes the production
// extractor — not a re-implementation. Per-user GENUINE windows are produced from
// the user's `training_files` sessions; the offline harness (runEvaluation, reused
// unchanged) then trains on a user's own windows and treats every OTHER user's
// windows as impostors — exactly mirroring the Killourhy & Maxion keystroke setup.
//
// Each session CSV row is `record timestamp, client timestamp, button, state, x, y`
// (timestamps in seconds). We map a row to a position-indexed `MouseSample` reading
// ONLY x/y/time + the coarse state (click vs move) — never any content (the privacy
// rule holds: windows are motion geometry/timing, and the raw dataset is gitignored
// and never committed).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIN_MOUSE_SAMPLES,
  extractMouseWindowFeatures,
  type MouseSample,
} from '@cerberus/shared-types';

import type { MouseBenchmarkWindowConfig } from './config';

const SECONDS_TO_MS = 1000;

/** Balabit `state` → position-indexed sample kind (clicks vs movement). */
function stateToKind(state: string): MouseSample['kind'] {
  if (state === 'Pressed') {
    return 'down';
  }
  if (state === 'Released') {
    return 'up';
  }
  return 'move'; // Move / Drag / scroll Down|Up — all movement/position updates
}

/** Parse one Balabit session CSV into time-ordered pointer samples. */
export function parseBalabitSession(content: string): MouseSample[] {
  const lines = content.split(/\r?\n/u);
  const samples: MouseSample[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    // skip header (row 0)
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    const cols = line.split(',');
    // record timestamp, client timestamp, button, state, x, y
    const t = Number(cols[1]);
    const state = (cols[3] ?? '').trim();
    const x = Number(cols[4]);
    const y = Number(cols[5]);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue; // a malformed row is dropped, not fatal
    }
    samples.push({ x, y, t: t * SECONDS_TO_MS, kind: stateToKind(state) });
  }
  return samples;
}

/**
 * Slice a session's samples into feature windows via the SHARED M10 extractor.
 * Windows are `windowStep` apart (non-overlapping when step == windowSize), and at
 * most `maxWindowsPerSession` are taken (deterministic: the first N, in order).
 */
export function windowizeSession(
  samples: readonly MouseSample[],
  config: MouseBenchmarkWindowConfig,
): number[][] {
  const windows: number[][] = [];
  for (
    let start = 0;
    start + config.windowSize <= samples.length && windows.length < config.maxWindowsPerSession;
    start += config.windowStep
  ) {
    const window = samples.slice(start, start + config.windowSize);
    if (window.length >= MIN_MOUSE_SAMPLES) {
      windows.push(extractMouseWindowFeatures(window));
    }
  }
  return windows;
}

function listDirs(parent: string): string[] {
  return readdirSync(parent)
    .filter((name) => !name.startsWith('.') && statSync(join(parent, name)).isDirectory())
    .sort();
}

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isFile())
    .sort();
}

/**
 * Load per-user genuine feature windows from a Balabit dataset root (the dir that
 * contains `training_files/`). Returns Map<user, number[][]> ready for
 * runEvaluation — sorted by user, then session filename, then window index, so the
 * protocol order is deterministic.
 */
export function loadBalabitByUser(
  rootDir: string,
  config: MouseBenchmarkWindowConfig,
): Map<string, number[][]> {
  const trainingDir = join(rootDir, 'training_files');
  const byUser = new Map<string, number[][]>();
  for (const user of listDirs(trainingDir)) {
    const userDir = join(trainingDir, user);
    const windows: number[][] = [];
    for (const session of listFiles(userDir)) {
      const samples = parseBalabitSession(readFileSync(join(userDir, session), 'utf8'));
      windows.push(...windowizeSession(samples, config));
    }
    if (windows.length > 0) {
      byUser.set(user, windows);
    }
  }
  return byUser;
}
