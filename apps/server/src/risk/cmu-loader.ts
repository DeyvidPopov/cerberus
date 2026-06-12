// CMU keystroke-dynamics dataset loader (ADR-0002, ADR-0009; PROJECT.md §6).
//
// Validates that the SAME feature extractor used for live capture also runs on
// the published benchmark format — proving the pipeline is correct end to end.
// This is feature-extraction validation, NOT scoring (FAR/FRR/EER is M7).
//
// The dataset (Killourhy & Maxion, "Comparing Anomaly-Detection Algorithms for
// Keystroke Dynamics", DSL-StrongPasswordData.csv) records, for the fixed
// password ".tie5Roanl"+Return (11 keys), per row: H.<key> hold times,
// DD.<k1>.<k2> down-down latencies, UD.<k1>.<k2> up-down latencies — all in
// SECONDS. We classify columns by prefix, reconstruct a per-key down/up timeline,
// and feed it to `extractFeatureVector`, so the extractor's definition (not a
// re-implementation) produces the vector. Units are converted seconds → ms to
// match the live-capture schema.
//
// The loader reads ONLY timing columns by prefix; the key names embedded in
// column headers (e.g. "DD.t.i") are dataset structure, not captured identity,
// and never enter a feature vector (the privacy rule holds: vectors are durations).
import { readFileSync } from 'node:fs';

import { extractFeatureVector, type KeystrokeTiming } from '@cerberus/shared-types';

const SECONDS_TO_MS = 1000;
const SUBJECT_COLUMN = 'subject';

export interface CmuSample {
  subject: string;
  /** Typing session (1..8 in the CMU dataset); 0 if the column is absent. */
  sessionIndex: number;
  /** Repetition within the dataset; falls back to file order if the column is absent. */
  rep: number;
  /** Position-indexed feature vector (ms), produced by the shared extractor. */
  features: number[];
}

interface ColumnLayout {
  subjectIndex: number;
  sessionIndexIndex: number; // -1 if absent
  repIndex: number; // -1 if absent
  holdIndices: number[];
  downDownIndices: number[];
}

function classifyColumns(header: readonly string[]): ColumnLayout {
  let subjectIndex = -1;
  let sessionIndexIndex = -1;
  let repIndex = -1;
  const holdIndices: number[] = [];
  const downDownIndices: number[] = [];
  header.forEach((rawName, index) => {
    const name = rawName.trim();
    if (name === SUBJECT_COLUMN) {
      subjectIndex = index;
    } else if (name === 'sessionIndex') {
      sessionIndexIndex = index;
    } else if (name === 'rep') {
      repIndex = index;
    } else if (name.startsWith('H.')) {
      holdIndices.push(index);
    } else if (name.startsWith('DD.')) {
      downDownIndices.push(index);
    }
    // UD.* columns are ignored: the extractor derives UD from the reconstructed
    // timeline (UD = DD − H), reproducing the dataset's own UD by construction.
  });
  if (subjectIndex === -1) {
    throw new Error('CMU dataset missing a "subject" column');
  }
  if (holdIndices.length < 2 || downDownIndices.length !== holdIndices.length - 1) {
    throw new Error('CMU dataset has an unexpected H./DD. column layout');
  }
  return { subjectIndex, sessionIndexIndex, repIndex, holdIndices, downDownIndices };
}

/**
 * Reconstruct a down/up timeline from hold + down-down latencies (seconds → ms):
 *   down[0] = 0; up[i] = down[i] + H[i]; down[i+1] = down[i] + DD[i].
 * The resulting UD[i] = down[i+1] − up[i] = DD[i] − H[i], i.e. the dataset's UD.
 */
function reconstructTimings(holdsSec: readonly number[], downDownSec: readonly number[]): KeystrokeTiming[] {
  const timings: KeystrokeTiming[] = [];
  let down = 0;
  for (let i = 0; i < holdsSec.length; i += 1) {
    if (i > 0) {
      down += (downDownSec[i - 1] ?? 0) * SECONDS_TO_MS;
    }
    const hold = (holdsSec[i] ?? 0) * SECONDS_TO_MS;
    timings.push({ down, up: down + hold });
  }
  return timings;
}

function parseRow(cols: readonly string[], layout: ColumnLayout, fileIndex: number): CmuSample {
  const holdsSec = layout.holdIndices.map((i) => Number(cols[i]));
  const downDownSec = layout.downDownIndices.map((i) => Number(cols[i]));
  if ([...holdsSec, ...downDownSec].some((v) => !Number.isFinite(v))) {
    throw new Error('CMU row has a non-numeric timing value');
  }
  const timings = reconstructTimings(holdsSec, downDownSec);
  const sessionIndex =
    layout.sessionIndexIndex >= 0 ? Number(cols[layout.sessionIndexIndex]) : 0;
  const rep = layout.repIndex >= 0 ? Number(cols[layout.repIndex]) : fileIndex;
  return {
    subject: (cols[layout.subjectIndex] ?? '').trim(),
    sessionIndex: Number.isFinite(sessionIndex) ? sessionIndex : 0,
    rep: Number.isFinite(rep) ? rep : fileIndex,
    features: extractFeatureVector(timings),
  };
}

/** Parse CMU CSV content into position-indexed samples via the shared extractor. */
export function parseCmuCsv(content: string): CmuSample[] {
  const lines = content.split(/\r?\n/u).filter((l) => l.trim().length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new Error('CMU dataset is empty');
  }
  const layout = classifyColumns(headerLine.split(','));
  return lines.slice(1).map((line, i) => parseRow(line.split(','), layout, i));
}

/** Load and parse a CMU dataset CSV from disk. */
export function loadCmuDataset(path: string): CmuSample[] {
  return parseCmuCsv(readFileSync(path, 'utf8'));
}

/** All feature vectors for one subject (a per-subject baseline fixture). */
export function vectorsForSubject(samples: readonly CmuSample[], subject: string): number[][] {
  return samples.filter((s) => s.subject === subject).map((s) => s.features);
}

/**
 * Group samples by subject, ordered by (sessionIndex, rep) within each subject —
 * the canonical order the Killourhy & Maxion protocol assumes ("first 200 reps",
 * "first 5 reps"). The CMU file is already sorted this way; sorting makes the
 * protocol order explicit and robust regardless of input row order.
 */
export function groupCmuBySubject(samples: readonly CmuSample[]): Map<string, number[][]> {
  const bySubject = new Map<string, CmuSample[]>();
  for (const sample of samples) {
    const existing = bySubject.get(sample.subject);
    if (existing) {
      existing.push(sample);
    } else {
      bySubject.set(sample.subject, [sample]);
    }
  }
  const grouped = new Map<string, number[][]>();
  for (const [subject, rows] of bySubject) {
    const ordered = [...rows].sort((a, b) =>
      a.sessionIndex !== b.sessionIndex ? a.sessionIndex - b.sessionIndex : a.rep - b.rep,
    );
    grouped.set(
      subject,
      ordered.map((r) => r.features),
    );
  }
  return grouped;
}
