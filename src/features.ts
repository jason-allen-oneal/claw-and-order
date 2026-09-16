import { createHmac } from 'node:crypto';
import type { Artifact, Observation } from './types.ts';
import { makeSketch } from './similarity.ts';

// Content is transient. Fenced/inline code and Markdown quotations are not writing signals.
export function conversationalText(content: string): string {
  let fence: '`' | '~' | null = null;
  let fenceLength = 0;
  let multiQuote = false;
  const lines: string[] = [];
  for (const line of content.slice(0, 16000).split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (multiQuote) continue;
    if (trimmed.startsWith('>>>')) { multiQuote = true; continue; }
    if (trimmed.startsWith('>')) continue;
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      const kind = marker[0] as '`' | '~';
      if (!fence) { fence = kind; fenceLength = marker.length; }
      else if (fence === kind && marker.length >= fenceLength) fence = null;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines.join(' ').replace(/(`+)[\s\S]*?\1/g, ' ').replace(/\s+/g, ' ').trim();
}
export function contentFeatures(content: string, key: string, guildId: string, authorId: string): Pick<Observation, 'contentLength' | 'fingerprint' | 'artifacts' | 'similarity'> {
  if (Buffer.byteLength(key) < 32) throw new Error('Fingerprint key is too short');
  const text = conversationalText(content).normalize('NFKC');
  const artifacts: Artifact[] = [];
  // Explicitly attributed logs/examples are excluded from ALL content signals, not
  // just artifact matching. Otherwise copied support logs inflate repetition/bursts.
  const attributed = /\b(?:pasted|example output|debug logs|(?:my|the) (?:agent|bot|model) (?:said|returned|printed|replied|output)|here is the output|(?:error|output|logs?) (?:I|we) (?:got|received)|stack trace)\b/i.test(text);
  if (attributed) return { contentLength: 0, fingerprint: null, artifacts: [], similarity: null };
  // Match structures, not bare vocabulary such as "tool_calls" in a support question.
  if (/(?:<tool_call>[^]*<\/tool_call>|"tool_calls"\s*:\s*\[\s*\{|<function_calls>[^]*<\/function_calls>)/i.test(text)) artifacts.push('tool-envelope');
  if (/(?:["']?tool_use_id["']?\s*[:=]\s*["']?[a-z0-9_-]+|assistant\s+to=(?:functions|tools)\.[a-z_]+|recipient_name\s*[=:]\s*["']?(?:functions|tools)\.[a-z_]+)/i.test(text)) artifacts.push('execution-marker');
  return {
    contentLength: text.length,
    fingerprint: text.length >= 80
      ? createHmac('sha256', key).update(`${guildId}:${authorId}:`).update(text.toLowerCase()).digest('hex')
      : null,
    artifacts,
    similarity: text.length >= 80 ? makeSketch(text, key, guildId, authorId) : null,
  };
}
