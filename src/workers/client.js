// Main-thread side of the geometry worker: one job at a time per call, cancel by terminate

const WORKER_URL = new URL('./geometry.worker.js', import.meta.url);

// Starts a job. Returns { promise, cancel }. onProgress receives info objects.
export function startJob(type, payload, onProgress = () => {}) {
  const worker = new Worker(WORKER_URL, { type: 'module' });
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.kind === 'progress') {
        onProgress(message.info);
        return;
      }
      settled = true;
      worker.terminate();
      if (message.kind === 'result') resolve(message.output);
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      settled = true;
      worker.terminate();
      reject(new Error(`worker: ${event.message}`));
    };
    worker.postMessage({ id: 1, type, payload });
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      worker.terminate();
    },
  };
}
