// Killourhy & Maxion (2009) evaluation harness (ADR-0002, ADR-0010; PROJECT.md §6).
//
// Protocol, per subject S treated as the genuine user:
//   - TRAIN on S's first `trainSize` (200) genuine repetitions.
//   - GENUINE test = S's remaining repetitions (reps 201..end).
//   - IMPOSTOR test = the first `impostorReps` (5) repetitions of EVERY OTHER subject.
//   - Score both sets with each detector; compute the per-subject EER.
// Aggregate the mean ± SD of the per-subject EER across all subjects, per detector.
//
// Deterministic: subjects/impostors are processed in sorted order and the only
// randomized detector (isolation forest) is seeded, so the report reproduces
// exactly on re-run (PROJECT.md §6).
import type { EvaluationConfig } from './config';
import type { DetectorFactory } from './detectors';
import { equalErrorRate, meanStd } from './eer';

export interface SubjectEer {
  subject: string;
  eer: number;
  far: number;
  frr: number;
}

export interface DetectorReport {
  name: string;
  meanEer: number;
  stdEer: number;
  meanFar: number;
  meanFrr: number;
  perSubject: SubjectEer[];
}

export interface EvaluationReport {
  protocol: 'killourhy-maxion-2009';
  subjects: number;
  dimension: number;
  trainSize: number;
  impostorReps: number;
  seed: number;
  detectors: DetectorReport[];
}

/** Run the full Killourhy & Maxion comparison over all qualifying subjects. */
export function runEvaluation(
  dataBySubject: Map<string, number[][]>,
  detectors: DetectorFactory[],
  config: EvaluationConfig,
): EvaluationReport {
  const subjects = [...dataBySubject.keys()].sort();
  // A subject qualifies as a GENUINE subject under test only if it has enough reps
  // for training + a non-empty genuine test set.
  const qualifying = subjects.filter((s) => (dataBySubject.get(s)?.length ?? 0) > config.trainSize);
  // Impostor eligibility is independent: any other subject with at least
  // `impostorReps` reps contributes impostor samples (Killourhy & Maxion). On the
  // canonical CMU dataset (all subjects have 400 reps) the two sets are identical.
  const impostorPool = subjects.filter(
    (s) => (dataBySubject.get(s)?.length ?? 0) >= config.impostorReps,
  );

  let dimension = 0;
  const perDetector = new Map<string, SubjectEer[]>();
  for (const detector of detectors) {
    perDetector.set(detector.name, []);
  }

  for (const subject of qualifying) {
    const genuine = dataBySubject.get(subject) ?? [];
    const train = genuine.slice(0, config.trainSize);
    const genuineTest = genuine.slice(config.trainSize);
    dimension = train[0]?.length ?? dimension;

    const impostorTest: number[][] = [];
    for (const other of impostorPool) {
      if (other === subject) continue;
      const otherSamples = dataBySubject.get(other) ?? [];
      impostorTest.push(...otherSamples.slice(0, config.impostorReps));
    }

    for (const detector of detectors) {
      const scorer = detector.train(train);
      const genuineScores = genuineTest.map(scorer);
      const impostorScores = impostorTest.map(scorer);
      const result = equalErrorRate(genuineScores, impostorScores);
      perDetector.get(detector.name)?.push({
        subject,
        eer: result.eer,
        far: result.far,
        frr: result.frr,
      });
    }
  }

  const detectorReports: DetectorReport[] = detectors.map((detector) => {
    const perSubject = perDetector.get(detector.name) ?? [];
    const eer = meanStd(perSubject.map((s) => s.eer));
    return {
      name: detector.name,
      meanEer: eer.mean,
      stdEer: eer.std,
      meanFar: meanStd(perSubject.map((s) => s.far)).mean,
      meanFrr: meanStd(perSubject.map((s) => s.frr)).mean,
      perSubject,
    };
  });

  return {
    protocol: 'killourhy-maxion-2009',
    subjects: qualifying.length,
    dimension,
    trainSize: config.trainSize,
    impostorReps: config.impostorReps,
    seed: config.seed,
    detectors: detectorReports,
  };
}
