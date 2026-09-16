# Architecture and operating boundaries

## Data path

Official Discord Gateway -> exact scope filter -> transient feature extraction -> bounded serial write queue -> PostgreSQL -> private reviewer command -> channel-permission filter -> bounded feature snapshot -> worker -> ephemeral report.

Only numeric timing, message/guild/member/channel IDs, reply references, normalized-text lengths, keyed fingerprints, and artifact labels are retained. The bot does not store bodies, profile fields, attachments, embeddings, presence, or voice data. A fingerprint is HMAC-SHA256 keyed by a local secret and namespaced to one guild/member. These are pseudonymous records, not anonymous data.

The collector uses explicit channel IDs, not category inheritance. No member-list or history crawl exists. The queue is single-process; use **one collector instance** for this scaffold. Multiple replicas need stronger database serialization and distributed load controls before deployment.

## Evidence and abstention

Reply latency is measured only when both the reply and its target were observed in the same channel and have different authors. No parent lookup is guessed from adjacent channel messages. Unobserved parents are missing measurements. Timing thresholds are experimental proposals, not statistically established automation signatures.

Duplicate text is compared within one account and guild. Short content, code blocks, quotes, and several attributed-log patterns are excluded. This is conservative parsing, not perfect conversation understanding. Unmarked debug logs can still trigger artifact signals. Copy-pasted AI assistance is not equivalent to automated account control.

All heuristics are deterministic and tested. Scores are not calibrated; `automationProbability` remains null. The worker runs with an empty environment and a memory/time budget, and only receives derived observations. **A worker thread is not an OS security sandbox.** It shares a process and filesystem privileges with the application. No LLM, shell commands, tool execution, arbitrary module loading, or model providers are connected. A future LLM reviewer belongs in a separately restricted service, not this worker with additional privileges.

## Access and privacy

Live collection defaults off, with an explicit policy-review acknowledgment and channel allowlist required to start it. The acknowledgment records an operator decision, not actual permission from Discord. Before live use, resolve whether the proposed review/scoring use is permissible under current Developer Policy, obtain required approvals, publish notice and an appeal/deletion process, and document retention. No message-derived model training is provided.

Only members with Manage Server permission can invoke commands, and only in the configured moderator channel. Every reply is ephemeral. Review queries intersect observed channels with the moderator's current View Channel and Read Message History access. Role and evidence-channel permissions are force-refreshed before delivery. Discord-side changes between the final check and message delivery cannot be made atomic by this application.

Retention removes observations on startup and hourly, and review queries respect the chosen retention window immediately. Tombstones expire based on removal time. Erasure cannot retract exported JSON files, Discord attachment copies, database logs, replicas, or backups. Set their retention separately. Treat the DB URL, token, fingerprint secret, reports, and database as sensitive.

## Reliability limits

Message IDs make ordinary replay idempotent. Edits and deletes invalidate evidence and add replay tombstones. The queue serializes observation writes and erasure. Work is bounded; dropped events and write errors are counted and shown to reviewers. Known collection loss in the current process suppresses aggregate scoring. Under overload or database failure, deletion delivery is not guaranteed; treat the sample as unreliable and stop collection until repaired. There is no durable retry/dead-letter queue yet.

Coverage is explicitly partial. Live observations exclude offline periods, missing access, dropped events, edited/deleted content, and observations before installation. Process counters reset on restart. There is no persistent gateway-session timeline or completeness estimate, and no always-online/overnight signal. Sampling limits cause score abstention instead of pretending the newest messages represent an entire window.

Reports are generated on demand, not stored as permanent member classifications. No automatic kick, ban, timeout, DM challenge, public accusation, or adversarial prompt probe is implemented. Enforcement decisions remain separate from these unvalidated observations.
