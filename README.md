# Claw & Order

Evidence-first Discord moderation tooling for reviewing ordinary accounts that may be posting through automation. This is **not** a registered-bot detector and **not** an AI-writing detector.

Status: experimental scaffold. It runs a deterministic analyzer against bounded activity samples. It does not establish whether a member is an AI agent. There is no trained model, calibrated probability, LLM connection, automatic enforcement, or production approval.

## What "live collection" means

It is **new-message monitoring**: while running and enabled, the bot observes messages arriving in the explicitly configured channels and saves derived observations for later `/review` requests. It does not scan old channel history, read DMs, watch other servers, or inspect anyone's computer.

`COLLECTION_ENABLED=false` means no new observations are saved. On a fresh install, reviews will therefore have no member activity to analyze. This is an installation default, not the intended operating mode of a configured deployment. `CONTENT_SIGNALS_ENABLED` separately controls extracting text-derived signals; when off, only metadata/reply timing is available. Enabling content analysis also requires the appropriate Message Content access and fingerprint secret.

`/status` now spells out whether monitoring is ON or OFF, whether content analysis is enabled, and that history backfill is absent. Analysis remains on demand through `/review`; continuous observation is not automatic case alerts. Follow the controlled-evaluation setup below to enable monitoring after scope and required permissions are established.

## Included

- TypeScript, discord.js, PostgreSQL, and a bounded analysis worker.
- `/review member [days]`, `/status`, and `/forget member confirm`, restricted to Manage Server permission and one configured moderator channel. Every response is ephemeral.
- Exact guild/channel scoping and permission-filtered reviews. Registered bots, webhooks, system messages, and DMs are excluded.
- Four checks in three explainable families: robust reply cadence and recurring cross-channel reply bursts (timing), exact/near-duplicate substantive text (repetition), and structured tool/execution artifacts. Grammar, punctuation, identity, account age, and nighttime activity are not scored.
- Keyed, per-guild/per-member text fingerprints and bounded similarity sketches. **Raw message content is never persisted by the application.** Markdown code/quotes are excluded from content features; explicit log-attribution patterns exclude attributed output from all content signals, including repetition.
- Live-event deduplication, edit/delete invalidation, replay tombstones, bounded ingestion, retention cleanup, and member-data erasure.
- Native Node tests, a synthetic offline demo, PostgreSQL integration tests, Docker Compose, and GitHub Actions.

## Try the offline demo

Use Node.js 24.17 or newer. These commands need neither a Discord token nor a database nor installed npm dependencies:

```sh
npm run demo
npm test
```

The database integration test is skipped unless `TEST_DATABASE_URL` points to a dedicated disposable PostgreSQL database. The demo is deliberately suspicious **synthetic** data; its score demonstrates plumbing, not accuracy.

## Local development

```sh
npm ci --ignore-scripts
cp .env.example .env
# Edit the settings. Leave COLLECTION_ENABLED=false initially.
docker compose up -d db
npm run db:migrate
npm run commands:register
npm run build
npm start
```

The committed lockfile records the dependency graph that passed CI, including the production dependency audit. Use `npm ci --ignore-scripts` for reproducible installs. CI also checks the emitted JavaScript, not just the TypeScript source. Do not enable lifecycle scripts just to make installation succeed.

Use an official Discord application with the `bot` and `applications.commands` scopes. Never provide a member token. Give it only the channel access required for the configured scope, not Administrator, Ban Members, Kick Members, or Moderate Members. No enforcement permissions are needed. Enable the privileged Message Content intent only when authorized and enabling content signals. Verify current Discord access/review requirements in the official documentation rather than assuming server count is sufficient.

Set `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_TOKEN`, and `MODERATOR_CHANNEL_ID`. Restrict the moderator channel to your team. Members invoking commands need Manage Server permission; the code checks this at runtime as well as declaring command defaults. The bot does not fetch member lists or request presence/member-list intents.

A review filters observations to channels the requesting moderator can currently view and read. It does not retrieve channel history. Edits remove the original observation rather than analyze potentially stale content; the edited message stays excluded for the retention period. Threads need their own explicit channel IDs.

## Enabling a controlled live evaluation

Read [the deployment and policy notes](docs/ARCHITECTURE.md) first. Discord's Developer Policy includes restrictions on profiling and on training from API-obtained message content. **A server administrator's authorization or an environment flag is not a substitute for any required Discord permission.** Confirm the intended use before operating against real member data.

After that review, explicitly set the guild/channel scope, `POLICY_REVIEW_ACKNOWLEDGED=true`, and `COLLECTION_ENABLED=true`. Content-derived features separately require `CONTENT_SIGNALS_ENABLED=true`, Message Content access, and a strong secret generated with `openssl rand -hex 32`. Without content signals, only observed reply timing is evaluated, and timing alone never produces `review-recommended`.

The bot defaults to seven-day retention, configurable from one to thirty days. Cleanup runs at startup and hourly while running. Backups, database logs, exported reports, and Discord-hosted ephemeral attachments have their own lifecycles; the bot cannot erase copies downloaded by moderators. Fingerprints and IDs are still personal data, not anonymization.

## Reading a report

Reports concern **one account during one window**, not a permanent identity. At least twenty distinct messages spanning thirty minutes are required to assign an aggregate heuristic score. Reaching the message cap causes abstention; choose a shorter window. Two distinct signal families are required for `review-recommended`. Related timing checks share one contribution, so cadence plus a reply burst does not count as two families. [Detector details and limitations](docs/DETECTOR.md) explain the experimental thresholds.

`heuristicScore` is an unvalidated weighted indicator, **not a percentage**. `automationProbability` is always `null`. An absence of strong indicators does not establish human operation. Every signal includes a stable check code, measured counts, evidence IDs, and an alternative explanation. `familyScores` explains the contribution caps. JSON attachments include Discord message links so authorized moderators can inspect original context without storing raw content here.

`/forget member confirm:true` erases that member's retained observations in this guild, not messages on Discord. It leaves short-lived message-ID tombstones to block replay; those contain no author or content. It is not an opt-out from collection of future activity.

## Upgrading from the initial scaffold

Run `npm run db:migrate` before restarting the upgraded bot. Migration 002 adds a nullable similarity-sketch column without replacing observations. Old observations retain exact matching and timing support, but cannot gain similarity sketches because their raw messages were never stored. Newly observed eligible messages get sketches.

## Docker

```sh
# Start database, then migrate using the built image.
docker compose --profile bot build bot
docker compose up -d db
docker compose --profile bot run --rm bot node dist/src/migrate.js
docker compose --profile bot run --rm bot node dist/src/register.js
docker compose --profile bot up -d bot
```

The bundled database password is local-development-only. Set a strong `POSTGRES_PASSWORD` for deployment and keep it consistent with connection settings. The database port binds to loopback. Production requires reviewed dependency locks/images, encrypted storage/backups, scoped credentials, network controls, and a published data-handling process.

## Project layout

```text
src/config.ts       Fail-closed configuration
src/features.ts     Transient content-to-feature extraction
src/analyzer.ts     Report assembly and family-capped scoring
src/timing.ts       Reply cadence and recurring cross-channel bursts
src/similarity.ts   Keyed, bounded shingle sketches
src/repetition.ts   Exact and near-duplicate grouping
src/status.ts       Plain-language monitoring status
src/worker.ts       Feature-only analysis worker entry
src/reviewer.ts     Worker timeout and memory limit
src/store.ts        Parameterized PostgreSQL persistence
src/bot.ts          Scoped collection and private commands
src/commands.ts     Command definitions and report presentation
src/queue.ts        Bounded, serial ingestion
migrations/         Database schema
test/              Unit and database integration tests
docs/              Architecture, limitations, and roadmap
```

See [SECURITY.md](SECURITY.md) before connecting this to another agent or tool runtime. No local OpenClaw checkout is loaded, trusted, or executed. See [the roadmap](docs/ROADMAP.md) for deliberately unfinished work.

## Primary references

- [Discord Gateway and privileged intents](https://docs.discord.com/developers/events/gateway)
- [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)
- [Automated user accounts policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
- [discord.js documentation](https://discord.js.org/docs/packages/discord.js/14.27.0)

No license has been selected for this repository. The scaffold does not assign one on the owner's behalf.
