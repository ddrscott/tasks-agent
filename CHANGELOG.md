# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-03

### Added
- Kanban board at askscottpierce.com/tasks with live sync across tabs, undo and redo, themes, and attachments
- Assistant in the sidebar — say "finished the dentist thing" and the cards move
- Needle 3 runs plain commands in the browser tab for free; GLM on Workers AI handles the rest
- Sign-in with an emailed code, Google, or Microsoft, with Turnstile on the email form
- Pro plan through Stripe, raising the daily assistant cap
- MCP server so Claude, ChatGPT, Cursor, Codex, and other agents can work the board, over OAuth or a personal access token
- Hybrid keyword and semantic search across titles and notes (⌘K)
- End-to-end encryption with a passphrase — the server keeps only ciphertext, built on JWE so a backup opens with any JOSE library
- Tags on cards — click one to fade out the rest; agents filter by tag over MCP
- Live event feed for agent sessions on your own machine — your changes to `#agent` cards wake the agent in seconds, with no tunnel or open port
- `tasks-events --tag <project>` — run one lead agent per repo, each hearing only its own cards
- Card notes render as markdown and switch to plain text to edit; checkboxes toggle in place
- // SESSIONS panel — every Claude Code session reporting in, grouped by project, needs-you first, stale after five quiet minutes
- Card claims over MCP, so two agents never take the same card, with the claiming session shown on the card
- One-tap answers — an agent asks a multiple-choice question and the card shows a button per option
- The footer shows the running version; click it for the latest changes

### Changed
- Card notes grow to fit, and the card editor stays within the viewport
- Card editor fields use full-contrast text instead of the label's gray, so entered values no longer look like placeholders

### Fixed
- `tasks-events` hung silently on a bad token — it now retries and prints one `offline` line
- Session `Stop` events were lost when `claude -p` exited right after them

### Security
- Sign-in codes are single-use, with guess budgets per email and per IP across resends
- Encrypted boards refuse plaintext from every path — chat, uploads, MCP, and stale tabs — and turning encryption off or changing the passphrase needs a key proof
- Cookie-bearing requests from other origins are refused, including sibling subdomains

[Unreleased]: https://github.com/ddrscott/tasks-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ddrscott/tasks-agent/releases/tag/v0.1.0
