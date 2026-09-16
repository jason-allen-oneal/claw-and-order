export type Artifact = 'tool-envelope' | 'execution-marker';
export type SignalFamily = 'timing' | 'repetition' | 'operational-artifact';

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
}
export interface ReviewMessage extends Observation {
  // Populated only by joining an observed reply target in the same channel.
  replyLatencyMs: number | null;
}
export interface Signal {
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
}
export interface Report {
  detectorVersion: 'heuristic-v0.1';
  subject: { guildId: string; authorId: string };
  window: { startAt: number; endAt: number };
  sample: { messages: number; channels: number; spanMs: number; truncated: boolean };
  priority: 'insufficient-evidence' | 'no-strong-indicators' | 'some-indicators' | 'review-recommended';
  heuristicScore: number | null;
  automationProbability: null;
  signals: Signal[];
  limitations: string[];
}
