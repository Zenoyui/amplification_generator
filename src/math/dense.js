// Dense symmetric positive definite solve (coarsest multigrid level)

export class CholeskyError extends Error {
  constructor(row, pivot) {
    super(`cholesky: pivot not positive (row=${row}, pivot=${pivot})`);
    this.name = 'CholeskyError';
  }
}

// Factors row-major n x n matrix in place into lower L (A = L L^T). Upper part is not read.
export function choleskyFactor(matrix, n) {
  for (let j = 0; j < n; j++) {
    let diag = matrix[j * n + j];
    for (let k = 0; k < j; k++) diag -= matrix[j * n + k] * matrix[j * n + k];
    if (!(diag > 0)) throw new CholeskyError(j, diag);
    const pivot = Math.sqrt(diag);
    matrix[j * n + j] = pivot;
    for (let i = j + 1; i < n; i++) {
      let acc = matrix[i * n + j];
      const rowI = i * n;
      const rowJ = j * n;
      for (let k = 0; k < j; k++) acc -= matrix[rowI + k] * matrix[rowJ + k];
      matrix[rowI + j] = acc / pivot;
    }
  }
}

// Solves L L^T x = rhs in place in rhs
export function choleskySolve(factor, n, rhs) {
  for (let i = 0; i < n; i++) {
    let acc = rhs[i];
    const row = i * n;
    for (let k = 0; k < i; k++) acc -= factor[row + k] * rhs[k];
    rhs[i] = acc / factor[row + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let acc = rhs[i];
    for (let k = i + 1; k < n; k++) acc -= factor[k * n + i] * rhs[k];
    rhs[i] = acc / factor[i * n + i];
  }
}

// Banded symmetric positive definite factorization. Storage: lower band, row i holds columns
// i - bandwidth .. i at offset i * (bandwidth + 1) + (col - (i - bandwidth)).
export function bandIndex(i, col, bandwidth) {
  return i * (bandwidth + 1) + (col - (i - bandwidth));
}

export function bandCholeskyFactor(band, n, bandwidth) {
  const stride = bandwidth + 1;
  for (let i = 0; i < n; i++) {
    const first = Math.max(0, i - bandwidth);
    for (let j = first; j <= i; j++) {
      let acc = band[i * stride + (j - (i - bandwidth))];
      const kFirst = Math.max(first, j - bandwidth);
      for (let k = kFirst; k < j; k++) {
        acc -= band[i * stride + (k - (i - bandwidth))] * band[j * stride + (k - (j - bandwidth))];
      }
      if (j === i) {
        if (!(acc > 0)) throw new CholeskyError(i, acc);
        band[i * stride + bandwidth] = Math.sqrt(acc);
      } else {
        band[i * stride + (j - (i - bandwidth))] = acc / band[j * stride + bandwidth];
      }
    }
  }
}

// Solves in place in rhs
export function bandCholeskySolve(band, n, bandwidth, rhs) {
  const stride = bandwidth + 1;
  for (let i = 0; i < n; i++) {
    let acc = rhs[i];
    for (let k = Math.max(0, i - bandwidth); k < i; k++) acc -= band[i * stride + (k - (i - bandwidth))] * rhs[k];
    rhs[i] = acc / band[i * stride + bandwidth];
  }
  for (let i = n - 1; i >= 0; i--) {
    let acc = rhs[i];
    const last = Math.min(n - 1, i + bandwidth);
    for (let k = i + 1; k <= last; k++) acc -= band[k * stride + (i - (k - bandwidth))] * rhs[k];
    rhs[i] = acc / band[i * stride + bandwidth];
  }
}
