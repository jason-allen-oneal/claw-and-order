# Roadmap

## Before real-member evaluation

Confirm Discord policy and intent access; document notice, reviewer access, retention, appeals, and deletion. Review the dependency lock and audit results. Exercise installation, migration, command registration, scope filters, permission revocation, and deletion in a dedicated authorized test guild.

## Next engineering work

Persist gateway coverage intervals and data-quality state across restarts. Add durable priority handling for invalidations and erasure, replay tests across reconnects, database failure recovery, and audit records that do not store content. Add command interaction mocks and a dedicated test-guild smoke test. Review pinned action revisions and pin container digests after validating supported versions. Expand Markdown parsing and evidence-context review without silently retaining raw content.

## Probability, only after evidence

Create independently established labels for manual posting, manually assisted posting, automation, mixed windows, and unresolved cases. Do not train on API-obtained content without required permission. Split evaluation by account and forward time. Evaluate precision at expected prevalence, false-positive rates, missing-data effects, reviewer agreement, and calibration on held-out data. Unknown is a valid result.

A future calibrated output must identify its model version, evaluated population, calibration dataset/version, date, label definition, and applicability limits. It must not reinterpret the current heuristic score as a probability.

## Deliberately absent

LLM judge/provider integration; embeddings; automatic enforcement; public rankings; permanent AI labels; agent-catching prompt tricks; collection from other servers; user-token/self-bot login; identity profiling. A moderator queue and feedback workflow are future work, not existing features.
