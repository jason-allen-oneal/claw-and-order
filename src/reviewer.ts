import { Worker } from 'node:worker_threads';
import { MAX_ANALYSIS_MESSAGES } from './analyzer.ts';
import type { Report, ReviewInput } from './types.ts';

export function reviewInWorker(input: ReviewInput): Promise<Report> {
  if (input.messages.length > MAX_ANALYSIS_MESSAGES) return Promise.reject(new Error('Review too large'));
  // Supports both native TypeScript development and emitted JavaScript production.
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`./worker.${extension}`, import.meta.url), {
      workerData: input, env: {}, resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Analysis timed out')); }, 5000);
    worker.once('message', (report: Report) => { clearTimeout(timer); resolve(report); void worker.terminate(); });
    worker.once('error', () => { clearTimeout(timer); reject(new Error('Analysis worker failed')); });
    worker.once('exit', code => { clearTimeout(timer); reject(new Error(`Analysis worker exited (${code})`)); });
  });
}
