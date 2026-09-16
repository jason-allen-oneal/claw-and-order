# Detector v0.3

This version has four structural checks plus an optional local semantic prototype check across four score families. Thresholds are experimental implementation choices, not validated human/agent boundaries. The changes make more behaviors observable and reports easier to audit; they do not establish greater predictive accuracy. No hosted model call, training, active challenge, or moderation action is added.

## Local semantic prototype similarity (semantic, up to 40 points)

When `SEMANTIC_ENABLED=true`, each new message is scored in-process with the configured MiniLM ONNX model while its body is transient. The scorer compares the embedding with several fixed positive prototypes describing structured assistant/task output and several negative prototypes describing informal human conversation. It records only the per-message score, nearest prototype, similarities, margin, and explanation strings; raw message content is never persisted.

The per-message score requires both a positive-versus-negative cosine margin of at least 0.10 and positive similarity of at least 0.20. The default thresholds are ranking heuristics, not calibrated decision boundaries. A high score means the message is semantically closer to the positive prototype set than the negative set; it does not establish that a person used an LLM, that a bot posted it, or that the account is automated. Polished human writing, support macros, documentation, and prepared responses remain valid alternatives. Multiple messages are averaged for the semantic family contribution, capped at 40 points, and still subject to the normal aggregate evidence gate for automatic cases.

## Reply cadence (timing, up to 30 points)

Use only observed replies with measured latency between 200 ms and 120 seconds. Both reply and parent must have been observed in the same channel, with different authors. Only the first eligible response to each parent counts, so multi-message answer chunks cannot inflate distinct triggers.

At least ten replies must fall within the larger of 200 ms or 15% of the median latency, accounting for at least 80% of observed eligible replies and spanning at least twenty minutes. A few delayed replies no longer erase a recurring cadence. Reports include the median, median absolute deviation, and numerator/denominator. These are observed intervals, not knowledge of when someone read a message or began composing.

## Recurring cross-channel bursts (timing, up to 35 points)

Look for three replies with different fingerprints, each at least 240 eligible characters, to different observed parents in three channels within fifteen seconds. Require at least three separate episodes, with their starts separated by five minutes. Candidate scans are bounded to 64 eligible messages per starting point.

This uses source creation timestamps, not the time events arrived at the collector. Missing parents, short replies, repeated copies of one announcement, and one dense burst do not qualify. Different fingerprints do not prove different meaning. Humans can prepare and paste responses; the detector does not claim superhuman typing or measure composition time.

## Rapid response speed (timing, up to 30 points)

Identifies replies where substantial messages (>=160 characters) arrive faster than human reading and composition speed (>40 characters per second, or under 2.5 seconds for 200+ characters). Requires at least four qualifying replies.

Timing signals share the timing family score cap and alone cannot produce `review-recommended`. Prepared answers, clipboard macros, and drafting responses in advance are documented alternatives.

## Unbroken circadian cadence (timing, up to 30 points)

Evaluates whether an account responds to users around the clock without human diurnal rest or sleep intervals. When evaluated across a span of at least 36 hours with 16+ observed replies, the detector measures the distribution of reply activity across UTC hourly buckets and the maximum elapsed time between consecutive replies.

Triggers when activity spans at least 20 of the 24 daily hour bins with no inactive interval greater than 4 hours. Shared accounts, round-the-clock shift rotations, and severe insomnia are documented alternative explanations.

## AI stylometry & discourse markers (stylometry, up to 35 points)

Identifies characteristic AI assistant discourse markers (e.g. self-referential AI identity formulas, formulaic assistant openers, hedging transitions, sycophantic praise, and closing assistance offers), structured markdown list/bold header patterns, markdown subheadings in conversational messages, and live untyped long message transmissions (>200 characters sent without Discord typing indicator telemetry). Requires at least two messages exhibiting these features.

Includes structural burstiness analysis: calculates the coefficient of variation in message length (`lengthCV`). Natural human conversation exhibits high burstiness (`lengthCV > 0.60`), whereas autonomous AI accounts typically display flat length uniformity (`lengthCV < 0.28`).

### Human conversational counter-evidence dampening

To protect articulate and helpful human server members who write structured responses or technical guides, isolated stylometry findings are automatically dampened when informal human conversational markers predominate (`humanRatio >= 0.20` or 3+ casual markers, and AI prevalence < 25%). Detected human indicators include:
- Discord custom emotes (`<:name:id>` or `<a:name:id>`)
- Unicode emojis (💀, 😂, 😭, 👍, etc.)
- User mentions (`<@id>`) and channel references (`<#id>`)
- Casual lowercase sentence starts on multi-word chat messages
- Natural conversational slang and internet acronyms (`idk`, `ngl`, `bruh`, `tbh`, `lmao`, `sus`, etc.)
- Message attachments and stickers (`hasMedia` telemetry)

Additionally, messages with repetitive vocabulary ($\ge 20$ words with Type-Token Ratio $< 0.40$) are flagged with the `low-lexical-diversity` artifact, contributing to stylometry indicators. Bot command invocations (prefixed by symbols such as `!`, `?`, `$`, `/`) are excluded from content feature extraction to avoid inflating repetition signals.

Attributed support logs and demonstrations are excluded from content analysis. Formal customer support templates and polished communication styles remain valid alternatives.

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

`automationProbability` remains null. Tests validate implementation behavior with synthetic fixtures and model availability where configured, not field precision, recall, false-positive rates, or calibration. Live Discord smoke testing and independent real-world evaluation remain necessary before relying on results.
