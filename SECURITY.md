# Security

Do not post tokens, database connection strings, private member data, or security-sensitive examples in public issues. Use GitHub private vulnerability reporting if enabled; otherwise contact the repository owner privately to arrange a report. No address or reporting capability is assumed here.

Treat every Discord message, attachment, URL, repository, and local OpenClaw clone as untrusted. This application never executes messages, downloads attachments, follows user links, or imports an OpenClaw checkout. Keep it separate from agent hosts and their credentials.

Use a dedicated official Discord bot and dedicated database role. Never use user tokens. Do not grant Administrator or enforcement permissions. Collection requires explicit scope and starts disabled. Never feed message content to a tool-enabled agent with secrets. No LLM provider is configured in this scaffold.

Worker environment isolation is not an OS sandbox. Container hardening is a starting point, not a security audit. Use encrypted storage/backups, limited egress and DB access, rotation, patching, and resource limits. Dependency installation disables lifecycle scripts. Review all generated locks and changes before deployment.

False accusations, prompt injection against future reviewers, privacy leaks, access-control bypass, stale evidence, denial of service, and misleading probabilities are security concerns. Scores are advisory, private, time-bounded, and unvalidated. Automation probability is intentionally absent.
