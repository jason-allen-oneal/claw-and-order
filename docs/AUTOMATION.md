# Continuous monitoring and automatic cases

This release adds a durable pipeline: new message -> derived observation and dirty-member job -> bounded automatic review -> one open case per member -> private moderator notification. It does not add bans, kicks, timeouts, member challenges, an LLM, or a calibrated probability.

## Enable

Run migration 003 and register commands before starting the updated bot. Set `COLLECTION_ENABLED=true`, `CONTENT_SIGNALS_ENABLED=true`, and `AUTO_REVIEW_ENABLED=true`. Supply the existing channel allowlist, application credentials, fingerprint secret, and policy acknowledgment. With AUTO_REVIEW_ENABLED omitted or blank, automatic review follows the two collection switches. An explicit false retains manual-only reviews. Explicit true without both inputs is rejected because timing alone cannot satisfy the case gate.

Default settings: tick every 15 seconds after the previous cycle finishes, at most 10 dirty members per cycle, and a five-minute per-member review interval. Intervals are scheduling limits, not guaranteed alert latencies. Work and API backlogs can delay reviews. No full-server history scan or member enumeration is performed. Idle members are not repeatedly analyzed. The configured message cap still causes abstention rather than an incomplete aggregate score.

A case requires the detector's review-recommended result, at least two distinct signal families, and a heuristic score of at least 60. The existing minimum of 20 messages spanning 30 minutes still applies. These are unvalidated implementation thresholds, not demonstrated detection accuracy.

## Case lifecycle

PostgreSQL enforces one open case per guild/member. Further reviews update that case's latest priority and score without posting another alert. Cases are retained for the configured retention period from creation; resolving a case starts a new retention period for its decision metadata. The initial report is not archived. `/case show` reruns the detector against currently retained observations the requesting moderator is allowed to read, so results can differ from the original trigger. An open case can legitimately have weak or insufficient current evidence.

`/case list [before]` lists up to 20 opaque case IDs and statuses with pagination. `/case show id` returns a fresh private review. `/case resolve id outcome` records dismissed, inconclusive, or independently confirmed automation. That last choice records a human assessment; it is not a model verdict or automatic training label. Resolution takes no enforcement action.

After resolution, the default cooldown is 24 hours. A subsequent case must also qualify on messages created after resolution; the old evidence cannot simply open the same case again. Cooldown cannot exceed retention. `/forget member confirm:true` atomically removes that member's observations, jobs, cases, and queued notifications. Future new messages may be observed again. Previously delivered generic Discord notices contain only an opaque case ID, no member identity, and are not deleted by the application. Previously downloaded manual reports remain outside its control.

## Notification privacy and delivery

Use a normal guild text channel as MODERATOR_CHANNEL_ID. It must explicitly deny View Channel to @everyone. Explicit View Channel grants must be to roles with Manage Server or Administrator, or to the bot itself. Member-specific grants to humans are intentionally rejected; use a moderator role instead. The bot needs View Channel, Send Messages, and Read Message History there, not Administrator or enforcement permissions. These strict checks apply before every notification attempt.

Shared alerts contain only a case number and instructions for `/case show`. They contain no subject ID, score, excerpts, evidence links, or source-channel information. This avoids assuming that every member of the moderator channel can read every source channel. Detailed slash-command results remain ephemeral and permission-filtered. Permissions are rechecked before releasing evidence.

Case creation and its outbox entry are one transaction. Notification failures use exponential backoff with at most six attempts. Retries search the most recent 100 moderator-channel messages for the bot's exact case marker and use a stable enforced Discord nonce. Delivery is **at least once, not exactly once**: Discord's nonce deduplication is time-limited, and a lost acknowledgement outside that period plus an exhausted history search can produce a duplicate notice. It does not create a duplicate case. Exhausted alerts are visible in `/status`; `/case retry-alert id` requeues an undelivered alert after fixing permissions or connectivity.

## Recovery and integrity

The queue coalesces repeated events per member, while keeping due times stable during busy conversations. Replayed message IDs do not dirty completed jobs. Monotonic revisions prevent a review calculated before an insert, edit, deletion, erasure, or case resolution from committing stale results. Unprocessed jobs and undelivered alerts survive restarts. A PostgreSQL session advisory lock permits only one collector process per guild, including across hosts. Deploy one replica, without sharding or multiple collectors; lock loss stops the process.

Automatic reviews use observations after the latest process start, Gateway recovery, or known collection fault. A restart therefore preserves cases and queued work but requires a new sufficient clean sample before fresh cases can be created. Messages received during downtime are not recovered through a history crawl. Ingestion loss advances the clean boundary rather than pretending complete coverage. Manual reviews still expose the original partial-coverage warnings.

`/status` shows monitoring and automatic-review switches, queue size, open case count, exhausted notices, and the clean-window boundary. Queue and notification failures never become positive evidence against a member.

## Validation boundaries

Offline tests cover scheduling, thresholds, cooldowns, clean-window invalidation, privacy checks, and delivery behavior with synthetic data and mocked transports. PostgreSQL integration tests cover migration, replay, revisions, atomic cases/outbox, duplicate suppression, resolution, fresh-evidence reopening, erasure, and the collector lock. These tests do not measure real-world precision/recall, prove Discord policy approval, or replace a live Discord smoke test.

Official API references: https://docs.discord.com/developers/resources/message and https://docs.discord.com/developers/topics/permissions .
