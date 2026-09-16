import { createHmac } from 'node:crypto';

// Bottom-k sketches of keyed four-token shingles, never raw words or plaintext hashes.
// These are retained content-derived data, not anonymous data. Scope and erase like observations.
export const SKETCH_SIZE = 32;
export interface SimilaritySketch {
  version: 'shingle-v1';
  tokenCount: number;
  hashes: string[];
}
export function makeSketch(text: string, key: string, guildId: string, authorId: string): SimilaritySketch | null {
  const tokens = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length < 24) return null;
  // Work is bounded before hashing. Long content outside this prefix is not compared.
  const bounded = tokens.slice(0, 1000);
  const hashes = new Set<string>();
  for (let i = 0; i <= bounded.length - 4; i++) {
    hashes.add(createHmac('sha256', key).update(`shingle-v1:${guildId}:${authorId}:`)
      .update(bounded.slice(i, i + 4).join(' ')).digest('hex').slice(0, 16));
  }
  if (hashes.size < 12) return null; // Repeated filler is not rich evidence.
  return { version: 'shingle-v1', tokenCount: bounded.length, hashes: [...hashes].sort().slice(0, SKETCH_SIZE) };
}
export function validSketch(value: unknown): value is SimilaritySketch {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<SimilaritySketch>;
  return s.version === 'shingle-v1' && Number.isInteger(s.tokenCount) && s.tokenCount! >= 24
    && s.tokenCount! <= 1000 && Array.isArray(s.hashes) && s.hashes.length >= 12 && s.hashes.length <= SKETCH_SIZE
    && s.hashes.every((h, i) => typeof h === 'string' && /^[a-f0-9]{16}$/.test(h)
      && (i === 0 || s.hashes![i - 1]! < h));
}
// Coordinated bottom-k union, not a plain Jaccard calculation over two truncated sets.
export function sketchSimilarity(a: SimilaritySketch, b: SimilaritySketch): number {
  if (!validSketch(a) || !validSketch(b)) return 0;
  if (Math.min(a.tokenCount, b.tokenCount) / Math.max(a.tokenCount, b.tokenCount) < 0.75) return 0;
  const left = new Set(a.hashes); const right = new Set(b.hashes);
  const union = [...new Set([...a.hashes, ...b.hashes])].sort().slice(0, SKETCH_SIZE);
  return union.filter(h => left.has(h) && right.has(h)).length / union.length;
}
