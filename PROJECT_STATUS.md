# PROJECT STATUS — Pi ClickUp

## Goal and current phase

Build a global Pi extension that replaces unstable ClickUp MCP/API tooling with direct, complete ClickUp Public API v2/v3 control. Current phase: operational maintenance. Core implementation, public-repository onboarding, initial QA (Claude Opus 4.8, the reviewer-of-record at the time), global installation, authenticated read-only validation, production promotion, and public CI are complete. The public repository uses `production` as its default branch.

### In review (2026-11-22): pagination and attachment download — v0.2.0

Authority: `CR-PICU-PaginationAndDownloads-0001.md`. Branch `feat/pagination-and-downloads` → PR into `development`. Author Claude Code Opus 5.5; reviewer-of-record GPT-6.2 (Sol) via Codex CLI, which holds merge authority (owner exception recorded in CR §10).

- `clickup_api` gains `paginate` (spec-gated `page`/`cursor`, caps 20 pages / 5000 items / 120 s, never partially merges a page, summary line first in output).
- Credentialed `clickup_api` requests refuse redirects (`redirect: "manual"`), so the token never leaves `/api/v2|v3`.
- New `clickup_download` tool: anonymous fetch from the exported attachment-host allowlist (`attachments.clickup.com`, `attachments-public.clickup.com`, `attachments2.clickup.com`, `t<digits>.p.clickup-attachments.com`), redirects refused, `max_bytes` default 25 MB / cap 100 MB, `timeout_ms` default 30 s / cap 120 s, `0600` exclusive create, overwrite staged and renamed only after a complete write, destination directory re-verified by identity before every file operation, confined to cwd or a private temp dir, confirmation on every call, `executionMode: "sequential"`.
- `AGENTS.md` security and reviewer lines amended with the CR §10 wording.
- Reviewer round 1 (GPT-6.2 Sol, 12 findings, CHANGES REQUIRED) addressed; `npm run verify`: 34 tests pass.
- Reviewer round 2 (CHANGES REQUIRED): fixed pre-aborted spec-lookup unhandled rejection, async download writes/fsync plus clock check before commit, fixed-length staging name, tool-level approved-overwrite and stale-cursor tests. Findings 1 (syscall-wide directory TOCTOU), 11 (no live task attachment), 12 (sandboxed verify) rebutted in the round-2 reply. `npm run verify`: 36 tests pass. Open: CR §8.5 manual verification of a real task-attachment host, recorded in the PR body.

### Releases (2026-08-01)

All reviewed by the then reviewer-of-record (Opus 4.8 QA Pi) and promoted through `development → staging → production`.

| Commit | Change |
|---|---|
| `f8ed446` | Declares `executionMode: "sequential"` on `clickup_api` so Pi's scheduler serializes any tool batch containing it, preventing two same-turn DELETE/upload confirmations from racing the same TUI dialog. |
| `416de6f` | Adds MIT `LICENSE` and `license` field, removes `private: true`. The repository is public and installed via `pi install git:...`, so absent a license a stranger had no grant to use or modify it. GitHub now reports the license as MIT. |
| (this commit) | Adds a `description` field and aligns `package.json` key order with `pi-teamwork` for cross-extension consistency. |

Dropping `private: true` removes npm's accidental-publish guardrail. Accepted deliberately: there is no publish step, `publishConfig`, or `NPM_TOKEN` in this repository, distribution is via `pi install git:` rather than the registry, and matching `pi-teamwork`'s shape was the goal. Restore the flag if registry publication is ever ruled out permanently.

## Source of truth

| Area | Source |
|---|---|
| Code, specs, checks | `https://github.com/umar-rana/pi-clickup-extension` and this local checkout |
| API contract | Official ClickUp v2/v3 OpenAPI specifications |
| Coordination | `PROJECT_STATUS.md` |
| New-Pi onboarding | `NTS-PICU-NewPiHandoff-0001.md` |
| Published project notes | Obsidian `03 Projects/PiClickUp/` |
| Tickets | ClickUp after activation |
| Global runtime | Pi user package `/Users/umar/Develop/PiCode/pi-clickup`; token file `~/.config/cu/token` |

## Team

| Pi | Model | Scope | Session ID |
|---|---|---|---|
| Dev/orchestrator | GPT-5.6 | implementation, sequencing, human interface | current session |
| QA reviewer-of-record | GPT-6.2 (Sol) via `codex exec -m gpt-6.2-sol` (from 2026-11-22; previously Claude Opus 4.8, `pi-clickup-qa`) | security/correctness review and merge | Codex CLI |
| Author (pagination/download CR) | Claude Code Opus 5.5 | implementation | current session |
| Docs/Ops | Current session | Obsidian, activation and smoke verification | current session |

## Merge authority

The author never merges. The reviewer-of-record named in `AGENTS.md` (GPT-6.2 Sol as of 2026-11-22, a different model family from the author) is the sole merge authority and may merge `development` into `staging`, then promote `staging` into `production`, after checks and activation gates pass. If rate-limited, report and pause; no ungated fallback merge.

## Branch and verification rules

`development → staging → production`. No direct commits to staging/production. Tests and typecheck are the merge gate. Runtime activation is verified after staging merge; it does not block pre-merge review. Production promotion follows successful activation testing.

## Continuous operation

Default to action on reversible routine choices. Self-report idle or rate-limited states. For longer work, inspect objective Git/check state at least hourly rather than trusting terminal text.

## Coding discipline

Ponytail full, enforced by `AGENTS.md` and QA. Security, trust-boundary validation, cancellation and data-loss prevention are not simplification targets.

## Accepted residual risk: download directory swap

`clickup_download` re-verifies the destination directory's identity synchronously before each
file syscall. A syscall-wide window remains where a second local principal with write access to
that directory's parent could swap it. Node exposes no `openat`/`fchdir`, and a `chdir` child
process was rejected for portability. Code carries a `shortcut:` comment.

Owner ruling, Umar 2026-11-22: **accepted**. The reviewer-of-record held that directory-relative
operations were required; the author accepted the risk; the deadlock was routed to the owner per
the three-cycle rule rather than settled by either agent.

## Known gap: automatic CI triggers

`.github/workflows/verify.yml` declares `push` and `pull_request` triggers, but neither has ever fired; every run in repository history is `workflow_dispatch`. Pushes to `development`, `staging`, and `production` during the `f8ed446` release produced no automatic run. The workflow is active and Actions are enabled, so the cause is external to the file (suspected account-level policy or repository-transfer artifact) and is under separate investigation.

Neither `staging` nor `production` has branch protection, so no status check is enforced at merge time. Until both are fixed, treat the merge gate as manual: run `npm run verify` locally and dispatch `verify.yml` explicitly before approving.

## Standing tasks

- Maintenance: run `npm run verify`, reviewer-of-record review, staging validation, then production promotion for every release.
- OpenAPI drift: no scheduled work; `clickup_docs` loads ClickUp's official specifications at runtime.

## Model assignment

The reviewer-of-record named in `AGENTS.md` (GPT-6.2 Sol via `codex exec -m gpt-6.2-sol` as of 2026-11-22, owner exception recorded in CR §10) is assigned to QA because this extension handles credentials, arbitrary mutations and local-file uploads; it must be a different model family from the author. The current strong coding model owns implementation. A separate Docs Pi is unnecessary at this project size; Docs/Ops remains mechanical work in the orchestrator session.
