// Preconditioned conjugate gradients with the multigrid V-cycle as preconditioner

const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_MAX_ITERATIONS = 200;

const dotProduct = (a, b) => {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += a[i] * b[i];
  return acc;
};

// Solves A x = b on the finest level of `multigrid`. Returns status; never hides non-convergence.
// onIteration(iteration, relativeResidual) is called after each step
export function solvePcg(multigrid, b, options = {}) {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const level = multigrid.levels[0];
  const n = b.length;
  const x = new Float64Array(n);
  const r = Float64Array.from(b);
  level.zeroBlocked(r);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  const normB = Math.sqrt(dotProduct(r, r));
  const history = [];
  if (!(normB > 0)) return { x, converged: true, iterations: 0, relativeResidual: 0, history };

  multigrid.cycle(0, r, z);
  p.set(z);
  let rz = dotProduct(r, z);
  let relativeResidual = 1;
  let iterations = 0;
  while (iterations < maxIterations) {
    level.apply(p, ap);
    const pap = dotProduct(p, ap);
    if (!(pap > 0)) return { x, converged: false, iterations, relativeResidual, history, breakdown: 'p.Ap not positive' };
    const alpha = rz / pap;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    iterations++;
    relativeResidual = Math.sqrt(dotProduct(r, r)) / normB;
    history.push(relativeResidual);
    if (options.onIteration) options.onIteration(iterations, relativeResidual);
    if (relativeResidual <= tolerance) break;
    multigrid.cycle(0, r, z);
    const rzNew = dotProduct(r, z);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }

  // true residual, recurrence drifts
  level.apply(x, ap);
  for (let i = 0; i < n; i++) ap[i] = b[i] - ap[i];
  level.zeroBlocked(ap);
  const trueResidual = Math.sqrt(dotProduct(ap, ap)) / normB;
  return {
    x,
    converged: trueResidual <= tolerance * 10,
    iterations,
    relativeResidual: trueResidual,
    history,
  };
}
