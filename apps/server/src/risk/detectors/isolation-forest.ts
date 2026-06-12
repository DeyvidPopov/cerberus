// Isolation Forest (Liu, Ting & Zhou, 2008) — ADR-0002, ADR-0010.
//
// An ensemble of random "isolation trees". Each tree recursively partitions a
// subsample by a random feature + random split value; anomalies are isolated with
// SHORTER average path lengths. The anomaly score s(x) = 2^(−E[h(x)]/c(ψ)) ∈ (0,1);
// higher ⇒ more anomalous. All randomness comes from a SEEDED PRNG, so the forest
// is reproducible (PROJECT.md §6). One of the two offline comparison detectors;
// not deployed live (ADR-0002).
import { createPrng, randomInt, sampleIndices, type Prng } from '../random';

const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Average path length of an unsuccessful BST search over n points (the c(n)
 * factor, Liu et al. 2008). Uses the EXACT harmonic number for the small cases
 * where the asymptotic ln(i)+γ is inaccurate — notably c(2)=1 (matching the
 * reference and scikit-learn), not 0.154 from the asymptotic form.
 */
export function averagePathLength(n: number): number {
  if (n <= 1) {
    return 0;
  }
  if (n === 2) {
    return 1; // exact H(1) = 1
  }
  const harmonic = Math.log(n - 1) + EULER_MASCHERONI;
  return 2 * harmonic - (2 * (n - 1)) / n;
}

type IsolationNode =
  | { kind: 'leaf'; size: number }
  | { kind: 'split'; feature: number; threshold: number; left: IsolationNode; right: IsolationNode };

function buildTree(
  points: readonly number[][],
  currentHeight: number,
  heightLimit: number,
  prng: Prng,
): IsolationNode {
  const n = points.length;
  if (currentHeight >= heightLimit || n <= 1) {
    return { kind: 'leaf', size: n };
  }
  const dimension = points[0]?.length ?? 0;
  const feature = randomInt(prng, dimension);

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const v = p[feature] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return { kind: 'leaf', size: n }; // cannot split a constant feature
  }

  const threshold = min + prng() * (max - min);
  const left: number[][] = [];
  const right: number[][] = [];
  for (const p of points) {
    if ((p[feature] ?? 0) < threshold) {
      left.push(p as number[]);
    } else {
      right.push(p as number[]);
    }
  }
  return {
    kind: 'split',
    feature,
    threshold,
    left: buildTree(left, currentHeight + 1, heightLimit, prng),
    right: buildTree(right, currentHeight + 1, heightLimit, prng),
  };
}

function pathLength(x: readonly number[], node: IsolationNode, currentLength: number): number {
  if (node.kind === 'leaf') {
    return currentLength + averagePathLength(node.size);
  }
  const branch = (x[node.feature] ?? 0) < node.threshold ? node.left : node.right;
  return pathLength(x, branch, currentLength + 1);
}

export interface IsolationForestParams {
  trees: number;
  subsampleSize: number;
  seed: number;
}

export interface IsolationForest {
  /** Anomaly score in (0,1): higher ⇒ more anomalous. */
  score: (x: readonly number[]) => number;
}

/** Train an isolation forest on `samples` (seeded → reproducible). */
export function trainIsolationForest(
  samples: readonly number[][],
  params: IsolationForestParams,
): IsolationForest {
  const prng = createPrng(params.seed);
  const psi = Math.min(params.subsampleSize, samples.length);
  const heightLimit = Math.ceil(Math.log2(Math.max(psi, 2)));
  const normalizer = averagePathLength(psi);

  const trees: IsolationNode[] = [];
  for (let t = 0; t < params.trees; t += 1) {
    const indices = sampleIndices(prng, samples.length, psi);
    const subsample = indices.map((i) => samples[i] ?? []);
    trees.push(buildTree(subsample, 0, heightLimit, prng));
  }

  return {
    score: (x: readonly number[]): number => {
      let total = 0;
      for (const tree of trees) {
        total += pathLength(x, tree, 0);
      }
      const expectedPath = total / trees.length;
      return normalizer > 0 ? 2 ** (-expectedPath / normalizer) : 0;
    },
  };
}
