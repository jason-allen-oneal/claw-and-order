import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as ort from 'onnxruntime-node';

export interface SemanticPrototype {
  label: string;
  text: string;
  polarity?: 'positive' | 'negative';
}

export interface SemanticScorerOptions {
  /** A model.onnx file, or the directory containing it and vocab.txt. */
  modelPath: string;
  tokenizerPath?: string;
  vocabPath?: string;
  prototypes: readonly SemanticPrototype[];
  /** Minimum positive-vs-negative cosine margin for an experimental hit. */
  threshold?: number;
  /** Minimum positive-prototype cosine similarity for an experimental hit. */
  minimumPositiveSimilarity?: number;
}

export interface SemanticScore {
  score: number;
  reasons: string[];
  nearestPrototype: string | null;
  similarity: number | null;
  margin: number | null;
}

interface PrototypeVector {
  label: string;
  polarity: 'positive' | 'negative';
  vector: Float32Array;
}

const MAX_TOKENS = 512;
// Cosine margins from sentence-transformer embeddings are usually much smaller
// than one. This is an experimental ranking threshold, not a calibrated cutoff.
const DEFAULT_THRESHOLD = 0.10;
const DEFAULT_MINIMUM_POSITIVE_SIMILARITY = 0.20;

function resolveAssetPath(modelPath: string, fileName: string): string {
  return modelPath.endsWith('.onnx') ? join(dirname(modelPath), fileName) : join(modelPath, fileName);
}

function basicTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const result: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current) result.push(current);
    current = '';
  };
  for (const character of normalized) {
    const code = character.codePointAt(0)!;
    const whitespace = /\s/u.test(character);
    const punctuation = /[!-/:-@[-`{-~]/u.test(character);
    const cjk = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
    if (whitespace) flush();
    else if (cjk || punctuation) { flush(); result.push(character); }
    else current += character;
  }
  flush();
  return result;
}

function wordPieceTokens(text: string, vocab: ReadonlyMap<string, number>): number[] {
  const ids: number[] = [vocab.get('[CLS]') ?? 101];
  for (const word of basicTokens(text)) {
    const pieces: string[] = [];
    let start = 0;
    let failed = false;
    while (start < word.length) {
      let end = word.length;
      let found: string | undefined;
      while (start < end) {
        const candidate = (start === 0 ? '' : '##') + word.slice(start, end);
        if (vocab.has(candidate)) { found = candidate; break; }
        end--;
      }
      if (!found) { failed = true; break; }
      pieces.push(found);
      start = end;
    }
    for (const piece of failed ? ['[UNK]'] : pieces) ids.push(vocab.get(piece) ?? vocab.get('[UNK]') ?? 100);
    if (ids.length >= MAX_TOKENS - 1) break;
  }
  ids.push(vocab.get('[SEP]') ?? 102);
  return ids.slice(0, MAX_TOKENS);
}

async function loadVocab(path: string): Promise<ReadonlyMap<string, number>> {
  const entries = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean);
  return new Map(entries.map((token, id) => [token, id]));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

function scoreFromSimilarities(
  similarities: readonly { label: string; polarity: 'positive' | 'negative'; similarity: number }[],
  threshold: number,
  minimumPositiveSimilarity: number,
): SemanticScore {
  if (!similarities.length) return {
    score: 0, reasons: ['No semantic prototypes were supplied.'], nearestPrototype: null, similarity: null, margin: null,
  };
  const positive = similarities.filter(p => p.polarity === 'positive').sort((a, b) => b.similarity - a.similarity)[0];
  const negative = similarities.filter(p => p.polarity === 'negative').sort((a, b) => b.similarity - a.similarity)[0];
  const nearest = [...similarities].sort((a, b) => b.similarity - a.similarity || a.label.localeCompare(b.label))[0]!;
  if (!positive || !negative) return {
    score: 0,
    reasons: ['Semantic scoring requires positive and negative prototypes.'],
    nearestPrototype: nearest.label,
    similarity: nearest.similarity,
    margin: null,
  };
  const margin = positive.similarity - negative.similarity;
  const marginMet = margin >= threshold;
  const similarityMet = positive.similarity >= minimumPositiveSimilarity;
  const score = marginMet && similarityMet
    ? Math.round(Math.max(0, Math.min(1, (margin - threshold) / Math.max(0.01, 1 - threshold))) * 100)
    : 0;
  const reasons = [`Positive prototype: ${positive.label} (${positive.similarity.toFixed(3)}).`, `Negative prototype: ${negative.label} (${negative.similarity.toFixed(3)}).`, `Semantic margin: ${margin.toFixed(3)}.`];
  reasons.push(marginMet ? `Semantic margin meets the configured threshold (${threshold.toFixed(2)}).` : `Semantic margin is below the configured threshold (${threshold.toFixed(2)}).`);
  reasons.push(similarityMet
    ? `Positive similarity meets the configured floor (${minimumPositiveSimilarity.toFixed(2)}).`
    : `Positive similarity is below the configured floor (${minimumPositiveSimilarity.toFixed(2)}).`);
  return { score, reasons, nearestPrototype: nearest.label, similarity: positive.similarity, margin };
}

export class SemanticScorer {
  private readonly session: ort.InferenceSession;
  private readonly vocab: ReadonlyMap<string, number>;
  private readonly prototypes: readonly PrototypeVector[];
  private readonly threshold: number;
  private readonly minimumPositiveSimilarity: number;

  private constructor(session: ort.InferenceSession, vocab: ReadonlyMap<string, number>,
    prototypes: readonly PrototypeVector[], threshold: number, minimumPositiveSimilarity: number) {
    this.session = session;
    this.vocab = vocab;
    this.prototypes = prototypes;
    this.threshold = threshold;
    this.minimumPositiveSimilarity = minimumPositiveSimilarity;
  }

  static async create(options: SemanticScorerOptions): Promise<SemanticScorer> {
    if (!options.modelPath?.trim()) throw new Error('Semantic model path is required');
    if (options.prototypes.some(p => !p.label || !p.text)) throw new Error('Semantic prototypes require labels and text');
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const minimumPositiveSimilarity = options.minimumPositiveSimilarity ?? DEFAULT_MINIMUM_POSITIVE_SIMILARITY;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error('Semantic threshold must be between 0 and 1');
    }
    if (!Number.isFinite(minimumPositiveSimilarity) || minimumPositiveSimilarity < -1 || minimumPositiveSimilarity > 1) {
      throw new Error('Minimum positive semantic similarity must be between -1 and 1');
    }
    const modelPath = options.modelPath.endsWith('.onnx') ? options.modelPath : join(options.modelPath, 'model.onnx');
    const vocabPath = options.vocabPath ?? resolveAssetPath(options.tokenizerPath ?? options.modelPath, 'vocab.txt');
    const [session, vocab] = await Promise.all([ort.InferenceSession.create(modelPath), loadVocab(vocabPath)]);
    const scorer = new SemanticScorer(session, vocab, [], threshold, minimumPositiveSimilarity);
    const vectors: PrototypeVector[] = [];
    for (const prototype of options.prototypes) vectors.push({ label: prototype.label, polarity: prototype.polarity ?? 'positive', vector: await scorer.embed(prototype.text) });
    return new SemanticScorer(session, vocab, vectors, threshold, minimumPositiveSimilarity);
  }

  async score(text: string): Promise<SemanticScore> {
    const vector = await this.embed(text);
    try {
      return scoreFromSimilarities(
        this.prototypes.map(p => ({ label: p.label, polarity: p.polarity, similarity: cosine(vector, p.vector) })),
        this.threshold,
        this.minimumPositiveSimilarity,
      );
    } finally {
      vector.fill(0);
    }
  }

  private async embed(text: string): Promise<Float32Array> {
    const ids = wordPieceTokens(text, this.vocab);
    const shape: [number, number] = [1, ids.length];
    const inputIds = new BigInt64Array(ids.map(BigInt));
    const mask = new BigInt64Array(ids.length).fill(1n);
    const types = new BigInt64Array(ids.length);
    const output = await this.session.run({
      input_ids: new ort.Tensor('int64', inputIds, shape),
      attention_mask: new ort.Tensor('int64', mask, shape),
      token_type_ids: new ort.Tensor('int64', types, shape),
    });
    const tensor = output.last_hidden_state as ort.Tensor;
    const dimensions = tensor.dims;
    const hidden = dimensions[dimensions.length - 1]!;
    const values = tensor.data as Float32Array;
    const vector = new Float32Array(hidden);
    for (let token = 0; token < ids.length; token++) for (let dimension = 0; dimension < hidden; dimension++) {
      vector[dimension] = vector[dimension]! + (values[token * hidden + dimension] ?? 0);
    }
    const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    vector.forEach((value, index) => { vector[index] = value / length; });
    inputIds.fill(0n); mask.fill(0n); types.fill(0n);
    return vector;
  }
}

export async function createSemanticScorer(options: SemanticScorerOptions): Promise<SemanticScorer> {
  return SemanticScorer.create(options);
}
