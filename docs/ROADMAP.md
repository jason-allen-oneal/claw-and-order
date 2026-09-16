# Roadmap

## Implemented

Scoped collection, feature-only storage, explainable heuristic analysis, exact and near-duplicate detection, reply cadence and cross-channel burst checks, private manual reviews, deletion/erasure/retention, synthetic tests, PostgreSQL integration tests, and reproducible CI.

Continuous automatic review and durable cases are now implemented. The queue coalesces activity, the database permits one open case per guild/member, the outbox retries alerts, and moderator commands resolve cases with cooldowns and fresh-evidence requirements. See AUTOMATION.md for operating constraints and failure handling.

## Before relying on live results

Confirm platform authorization, privileged intent access, and community notice requirements. Run a controlled Discord smoke test for channel scope, permissions, message create/edit/delete events, cases, retries, and shutdown/reconnect handling. Measure precision, false positives, recall, throughput, queue lag, and baseline prevalence using independently established labels and an approved evaluation design.

## Later

Calibration and a properly evaluated probability estimator; per-channel baselines; additional independently validated signals; richer case evidence snapshots with permission-aware invalidation; moderator role configurability; metrics endpoints and operational dashboards; optional isolated contextual review. A worker thread is not a security boundary for untrusted tools or future LLM access. Do not turn moderator suspicions into training ground truth or add enforcement based solely on an unvalidated score.
