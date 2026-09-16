import { createHmac } from 'node:crypto';
import type { Artifact, Observation } from './types.ts';

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
export function contentFeatures(content: string, key: string, guildId: string, authorId: string): Pick<Observation, 'contentLength' | 'fingerprint' | 'artifacts'> {
  if (Buffer.byteLength(key) < 32) throw new Error('Fingerprint key is too short');
  const text = conversationalText(content);
  const artifacts: Artifact[] = [];
  // Conservative suppression for explicitly attributed logs/examples. Still fallible.
  const attributed = /\b(?:pasted|example output|debug logs|(?:my|the) (?:agent|bot) (?:said|returned)|here is the output)\b/i.test(text);
  if (!attributed && /(?:<tool_call>[\s\S]*<\/tool_call>|"tool_calls"\s*:\s*\[)/i.test(text)) artifacts.push('tool-envelope');
  if (!attributed && /\b(?:tool_use_id|assistant to=functions\.|recipient_name\s*[=:]\s*functions\.)/i.test(text)) artifacts.push('execution-marker');
  return {
    contentLength: text.length,
    fingerprint: text.length >= 80
      ? createHmac('sha256', key).update(`${guildId}:${authorId}:`).update(text.toLowerCase()).digest('hex')
      : null,
    artifacts,
  };
}
