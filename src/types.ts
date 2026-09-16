import type { SimilaritySketch } from './similarity.ts';
import type { SemanticScore } from './semantic.ts';

export type Artifact = 'tool-envelope' | 'execution-marker' | 'ai-discourse' | 'ai-formatting' | 'untyped-long-message' | 'human-conversational' | 'low-lexical-diversity';
export type SignalFamily = 'timing' | 'repetition' | 'operational-artifact' | 'semantic' | 'stylometry';

// Deliberately no content, username, avatar, profile, presence, or cross-guild identity.
export interface Observation {
  guildId: string;
  messageId: string;
  authorId: string;
  channelId: string;
  createdAt: number;
  replyToId: string | null;
  contentLength: number | null;
  fingerprint: string | null;
  artifacts: Artifact[];
  // Absent on v0.1 records; old observations remain readable after migration.
  similarity?: SimilaritySketch | null;
  semantic?: SemanticScore | null;
}
export interface ReviewMessage extends Observation {
  // Populated only by joining an observed reply target in the same channel.
  replyLatencyMs: number | null;
}
export interface Signal {
  code: 'reply-cadence' | 'cross-channel-bursts' | 'repeated-content' | 'operational-markers' | 'semantic-similarity' | 'ai-stylometry' | 'rapid-response-speed' | 'unbroken-circadian';
  metrics: Record<string, number>;
  family: SignalFamily;
  points: number;
  description: string;
  messageIds: string[];
  alternative: string;
}
export interface ReviewInput {
  guildId: string;
  authorId: string;
  startAt: number;
  endAt: number;
  messages: ReviewMessage[];
  truncated: boolean;
  // Manual exploratory reviews may use a lower gate; automatic reviews keep analyzer defaults.
  scoreGate?: { minMessages: number; minSpanMs: number };
}
export interface Report {
  detectorVersion: 'heuristic-v0.3';
  subject: { guildId: string; authorId: string };
  window: { startAt: number; endAt: number };
  sample: { messages: number; channels: number; spanMs: number; truncated: boolean };
  priority: 'insufficient-evidence' | 'no-strong-indicators' | 'some-indicators' | 'review-recommended';
  heuristicScore: number | null;
  familyScores: Partial<Record<SignalFamily, number>>;
  automationProbability: null;
  signals: Signal[];
  limitations: string[];
}
