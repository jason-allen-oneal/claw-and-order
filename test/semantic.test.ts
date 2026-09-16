import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createSemanticScorer } from '../src/semantic.ts';

const modelPath = process.env.CLAW_AND_ORDER_MODEL_PATH ?? '/home/rev/projects/models/chroma/onnx_models/all-MiniLM-L6-v2/onnx';
const modelAvailable = await access(`${modelPath}/model.onnx`).then(() => true, () => false);
const prototypes = [
  { label: 'routine conversation', polarity: 'negative', text: 'A person is discussing a plan, asking a question, and responding naturally to another person.' },
  { label: 'automated operation', polarity: 'positive', text: 'A program executes a repeated workflow, posts a structured result, and reports the operation status.' },
] as const;

test('semantic scoring is deterministic and returns only derived fields', { skip: !modelAvailable }, async () => {
  const scorer = await createSemanticScorer({ modelPath, prototypes });
  const first = await scorer.score('The process ran the same scheduled operation and posted its structured status again.');
  const second = await scorer.score('The process ran the same scheduled operation and posted its structured status again.');
  assert.deepEqual(first, second);
  assert.equal(typeof first.score, 'number');
  assert.ok(first.score >= 0 && first.score <= 100);
  assert.ok(first.reasons.length > 0);
  assert.ok(!JSON.stringify(first).includes('scheduled operation'));
  assert.equal(Object.hasOwn(first, 'text'), false);
  assert.equal(typeof first.margin, 'number');
});

test('semantic scorer gives an experimental positive score to a matching operational message', { skip: !modelAvailable }, async () => {
  const scorer = await createSemanticScorer({ modelPath, prototypes });
  const result = await scorer.score('The program executed the scheduled workflow and posted the structured operation status.');
  assert.ok(result.score > 0);
  assert.ok(result.reasons.some(reason => reason.includes('meets')));
});

test('semantic scorer reports a below-threshold reason', { skip: !modelAvailable }, async () => {
  const scorer = await createSemanticScorer({ modelPath, prototypes, threshold: 1 });
  const result = await scorer.score('A short unrelated phrase.');
  assert.equal(result.score, 0);
  assert.ok(result.reasons.some(reason => reason.includes('below')));
});

test('semantic scorer requires an explicit model path', async () => {
  await assert.rejects(() => createSemanticScorer({ modelPath: '', prototypes }), /model path is required/);
});
