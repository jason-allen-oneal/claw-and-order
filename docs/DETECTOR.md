# Detector v0.2

This version has four checks across three score families. Thresholds are experimental implementation choices, not validated human/agent boundaries. The changes make more behaviors observable and reports easier to audit; they do not establish greater predictive accuracy. No LLM call, training, active challenge, or moderation action is added.

## Reply cadence (timing, up to 30 points)

Use only observed replies with measured latency between 200 ms and 120 seconds. Both reply and parent must have been observed in the same channel, with different authors. Only the first eligible response to each parent counts, so multi-message answer chunks cannot inflate distinct triggers.

At least ten replies must fall within the larger of 200 ms or 15% of the median latency, accounting for at least 80% of observed eligible replies and spanning at least twenty minutes. A few delayed replies no longer erase a recurring cadence. Reports include the median, median absolute deviation, and numerator/denominator. These are observed intervals, not knowledge of when someone read a message or began composing.

## Recurring cross-channel bursts (timing, up to 35 points)

Look for three replies with different fingerprints, each at least 240 eligible characters, to different observed parents in three channels within fifteen seconds. Require at least three separate episodes, with their starts separated by five minutes. Candidate scans are bounded to 64 eligible messages per starting point.

This uses source creation timestamps, not the time events arrived at the collector. Missing parents, short replies, repeated copies of one announcement, and one dense burst do not qualify. Different fingerprints do not prove different meaning. Humans can prepare and paste responses; the detector does not claim superhuman typing or measure composition time.

Cadence and bursts are correlated temporal observations. They contribute the maximum timing score, not 30 plus 35 points, and alone cannot produce `review-recommended`.

## Exact and near-duplicate text (repetition, up to 30 points)

Exact matching uses per-member/per-guild HMAC fingerprints. Near-duplicate matching adds HMAC-keyed four-token shingles with a sorted 32-entry bottom-k sketch. It requires at least 24 tokens and twelve distinct shingles. Only the first 1,000 eligible tokens are considered. Numeric and letter tokens from Unicode text are supported; this is not a calibrated language-independent detector.

Compare coordinated bottom-k unions, require similar lengths, and use an experimental similarity threshold of 0.78. Group against a representative rather than chaining similarity indefinitely. An inverted index uses four anchors per representative, at most 32 groups per anchor, and at most 64 candidate comparisons per message. Bounded lookup may miss matches; it does not make an exhaustive search claim.

A qualifying group needs at least four messages across at least two channels. At least ten substantive messages must be eligible, and qualifying groups must contain at least 30% of them. Exact and approximate matches share one family contribution. Human support templates remain an explicit alternative explanation.

## Structured operational markers (up to 35 points)

Match tool/function envelopes and execution-routing/key-value structures rather than bare mentions of API terms. Three candidate messages across at least two channels are needed. Saying `pending`, mentioning `tool_calls`, or discussing `tool_use_id` does not qualify on its own.

Code and quotes are removed before content analysis. Explicitly attributed logs or agent output are excluded from all content signals, not merely artifact detection. Attribution handling is heuristic: unmarked logs may still trigger and an agent may imitate attribution to avoid these checks. This is not an adversarially robust identity detector.

## Evidence, compatibility, and limitations

Signals carry a stable code, numeric measurements, evidence message IDs, and an alternative explanation. Related checks share contribution caps in `familyScores`. Aggregate scoring still requires twenty messages spanning thirty minutes, a non-truncated sample, and adequate data quality. Review escalation requires at least two distinct families; different families are not necessarily independent.

Migration 002 adds a nullable JSONB sketch column. Existing observations remain readable. No plaintext backfill is possible because bodies were not retained. Sketches follow message invalidation, member erasure, and retention. They are sensitive derived data and cannot be described as anonymous.

`automationProbability` remains null. Tests validate implementation behavior with synthetic fixtures, not field precision, recall, false-positive rates, or calibration. Live Discord smoke testing and independent real-world evaluation remain necessary before relying on results.
