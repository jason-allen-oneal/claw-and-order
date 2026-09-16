# Architecture

A single TypeScript service hosts Discord event ingestion, moderator commands, and the automatic review scheduler. PostgreSQL stores derived observations, message tombstones, coalescing review jobs, cases, and the notification outbox. Analysis runs in a bounded Node worker with an empty environment and no Discord credential. A worker thread is not a sandbox for future untrusted tool execution.

## Event path

The collector accepts new messages in the configured guild and explicit channel allowlist. Bot-authored messages are included only when `CAPTURE_BOT_MESSAGES=true`; webhooks, system messages, DMs, and unlisted threads remain excluded. Code and quotes are removed for content features; recognized attributed logs are excluded. Bodies are transient. When enabled, the local semantic classifier also receives transient text and persists only its derived score and reasons. Persisted data includes timestamps, reply references, keyed exact fingerprints, keyed similarity sketches, structured artifact categories, and semantic results, never plaintext message content.

Observation insertion and dirty-member scheduling share one SQL statement. Replayed message IDs do not create new jobs. Edits and deletions invalidate the observation and affected reply measurements. The bounded ingestion queue serializes creation, removal, erasure, and retention work. A database session lock permits one collector per guild; losing the lock stops that process.

## Review path

Manual /review requests and automatic batches share a process-level review mutex. The analyzer receives a bounded sample with explicitly measured reply latency. It uses signal-family caps and abstains on insufficient or truncated data. Automatic cases require at least two signal families, adequate history, and the configured threshold. A clean-window boundary excludes observations preceding a process restart, connection recovery, or known ingestion loss from new automatic cases.

Dirty jobs have monotonic revisions. A completed analysis can update case state only when its revision is still current. Case creation and notification enqueue are one transaction. A partial unique index permits one open case per guild/member. Further activity updates the existing case without another alert. Resolutions invalidate in-flight analysis, set cooldowns, and require fresh post-resolution evidence for another case.

## Access and retention

Command responses are ephemeral and restricted to Manage Server in the moderator channel. Detailed reviews are filtered by the requester's current source-channel permissions, rechecked before releasing evidence. Shared automatic alerts contain only opaque case numbers and static instructions; they do not disclose member identity or source evidence. The notification transport enforces a strict moderator-only channel configuration, reconciles recent messages on retry, and uses an enforced nonce. Its delivery semantics are at least once, not exactly once.

Raw reports are generated on request rather than archived. Case records retain minimal subject, priority, detector, timestamps, and human-resolution metadata. /case show produces a fresh permission-filtered analysis, not the historical trigger snapshot. Member erasure removes observations, jobs, cases, and pending notifications atomically. Retention cleanup removes expired cases and their outbox entries as well as old observation data. Downloaded reports and delivered generic case-number messages are outside automatic deletion.

See [AUTOMATION.md](AUTOMATION.md) for settings, commands, privacy requirements, retries, recovery, limitations, and the deployment checklist. See [DETECTOR.md](DETECTOR.md) for feature definitions and threshold limitations. No calibrated probability, automatic enforcement, or hosted/remote model access is implemented; the optional semantic classifier runs locally in the collector.
