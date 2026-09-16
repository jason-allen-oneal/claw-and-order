# Claw & Order

Discord moderation tooling for reviewing ordinary accounts that may be operated through automation. Not a registered-bot detector, an AI-writing detector, or a source of proven AI identity labels.

## Current capabilities

Continuous new-message monitoring, automatic behavioral reviews, persistent cases, and private moderator notifications. TypeScript, discord.js, PostgreSQL, a bounded analysis worker, Docker Compose, and GitHub Actions.

The detector checks reply cadence, recurring cross-channel reply bursts, exact/near-duplicate substantive text, and structured execution artifacts. Related checks share score caps. Evidence references, measurements, and alternative explanations accompany reviews. Grammar, punctuation, identity, account age, and nighttime activity are not scored. See [detector design](docs/DETECTOR.md).

A qualifying member automatically gets one open case, not an alert for every message. Reviews update that case; moderator resolution adds a cooldown and requires fresh evidence before another case can open. Pending reviews and notifications are persisted. There are no automated bans, kicks, or timeouts, and no LLM integration. `automationProbability` remains null because the detector is not calibrated. A heuristic score is not a probability.

## Try offline

Use Node.js 24.17 or newer. No Discord token, database, or installed dependencies are needed for the synthetic demo and offline tests:

```sh
npm run demo
npm test
```

PostgreSQL tests run only when TEST_DATABASE_URL explicitly points at a disposable test database. The synthetic demo verifies plumbing, not real-world accuracy.

## Install and run

```sh
npm ci --ignore-scripts
cp .env.example .env
# Configure the application, database, and explicit channel allowlist.
docker compose up -d db
npm run db:migrate
npm run commands:register
npm run check
npm start
```

Use the committed lockfile. Never provide an ordinary member token or enable dependency lifecycle scripts just to make installation succeed. Use an official Discord application with bot and applications.commands scopes. Give it only the channel permissions it needs, not Administrator, Ban Members, Kick Members, or Moderate Members. Content analysis requires the appropriate Message Content intent/access. Current platform permissions and policy review requirements must be checked before deployment.

Live collection means watching **new messages** in OBSERVED_CHANNEL_IDS while the process is running. It does not scan old channel history, read DMs, watch other servers, inspect computers, or enumerate members. Threads must be listed explicitly. With COLLECTION_ENABLED=false, no new observations are recorded.

For continuous monitoring and automatic case creation, configure:

```dotenv
COLLECTION_ENABLED=true
CONTENT_SIGNALS_ENABLED=true
AUTO_REVIEW_ENABLED=true
AUTO_REVIEW_TICK_SECONDS=15
AUTO_REVIEW_INTERVAL_SECONDS=300
AUTO_REVIEW_BATCH_SIZE=10
AUTO_CASE_THRESHOLD=60
CASE_COOLDOWN_HOURS=24
```

Also supply DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, MODERATOR_CHANNEL_ID, OBSERVED_CHANNEL_IDS, DATABASE_URL, and FINGERPRINT_SECRET. Generate the secret with `openssl rand -hex 32`. Changing the key breaks comparisons with retained fingerprints. Set POLICY_REVIEW_ACKNOWLEDGED=true only after reviewing the intended deployment; this setting is an operator acknowledgment, not Discord approval. Blank AUTO_REVIEW_ENABLED follows the collection/content switches; false keeps manual-only review available.

The moderator channel must be a guild text channel with an explicit @everyone View Channel denial and view grants only to Manage Server/Administrator roles or the bot itself. Member-specific human view grants are rejected for automatic notices; configure moderator access through roles. The bot needs View Channel, Send Messages, and Read Message History there. It posts only opaque case numbers; details are delivered through authorized private commands.

## Moderator commands

- `/status`: monitoring switches, queue size, case counts, failed alerts, and coverage boundary.
- `/review member [days]`: on-demand, permission-filtered review.
- `/case list [before]`, `/case show id`, `/case resolve id outcome`, `/case retry-alert id`: case review and resolution, without enforcement.
- `/forget member confirm:true`: erase retained member observations, case records, and queued work. New future activity may still be collected.

Commands require Manage Server and must run in the configured moderator channel. Responses are ephemeral. Source-channel access is checked before displaying evidence. Shared alerts disclose no subject IDs, scores, message excerpts, or source-channel links.

## Upgrading from v0.2

Stop the running process. Review your local changes before updating; do not overwrite them blindly.

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run db:migrate
npm run commands:register
npm run check
npm start
```

Migration 003 is additive and idempotent. Run one collector per guild; a database advisory lock prevents multiple instances. Restarts retain cases/jobs but start a new clean observation window. The detector still needs at least 20 messages spanning 30 minutes, two distinct signal families, and sufficient coverage before creating a case. Tick intervals are not guaranteed notification deadlines.

## Data and limitations

No raw message bodies are persisted by the application. It retains message metadata and keyed, per-guild/per-member fingerprints/sketches, plus minimal case and resolution metadata. Derived data is sensitive, not anonymous. Edits, deletions, replay suppression, erasure, and retention remain implemented. Reports downloaded by moderators are outside automatic erasure control.

No trained classifier, validated accuracy estimate, calibrated probability, live-server verification, or platform approval is implied by passing tests. Discord's Developer Policy includes restrictions on profiling and training with message content. Obtain clarification for your intended moderation deployment rather than treating local hosting or server-admin consent as automatic permission. See https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy .

[Automation operations and failure handling](docs/AUTOMATION.md) | [Architecture](docs/ARCHITECTURE.md) | [Roadmap](docs/ROADMAP.md) | [Security](SECURITY.md)
