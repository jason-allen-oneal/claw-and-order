import { parentPort, workerData } from 'node:worker_threads';
import { analyze } from './analyzer.ts';
import type { ReviewInput } from './types.ts';
// Only the bounded, derived feature snapshot crosses this boundary. No LLM is wired in.
if (!parentPort) throw new Error('Analysis worker needs a parent');
parentPort.postMessage(analyze(workerData as ReviewInput));
