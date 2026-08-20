# Hive Mind 2.0

Hive Mind 2.0 is a local, deterministic four-agent software studio. The backend—not agent prompts—owns workflow state, approved scope, provider settings, managed Git workspaces, exact commit identity, test evidence, retries, recovery, and promotion.

## Roles

- **Brain** is the only user-facing coordinator. The GUI and Discord share its conversation and workflow records.
- **Backend Developer** implements one frozen plan in a managed Git worktree.
- **Frontend Developer** builds and polishes the interface afterward, in that same worktree, on top of the backend's real commit rather than its own guesses.
- **Tester** validates the exact combined Developer/Frontend commit in a separate detached worktree and produces structured evidence.

No agent may select its own provider/model/effort, reorder workflow phases, approve plans, declare completion, push, or deploy.

## Safety and workflow invariants

1. Brain creates versioned plans. Matching planning work is revised as version `N+1` rather than replaced. A plan may name an existing local repository to work in instead of a workspace-managed one; once set, that location is fixed and cannot be changed from chat.
2. Only the latest plan version may be approved. Approval freezes that version and its acceptance criteria.
3. GUI and Discord approvals use the same Backend Developer/Frontend Developer/Tester provider preflight.
4. Backend Developer, Frontend Developer, and Tester run without routine approval after plan approval.
5. Work items for one managed project are serialized; different projects may run concurrently.
6. Tester checks a detached worktree at one exact commit and may not modify tracked source.
7. Every requested target must run successfully and produce an evidence receipt before it can pass.
8. Every passed/failed criterion must reference existing evidence inside the run's managed evidence directory, and a pass must cite at least one screenshot — every plan carries visual criteria, so log-only evidence cannot back a pass.
9. Every reproducible defect blocks. Suggestions do not block.
10. A Tester report rejection — unparseable output, schema drift, invented evidence, an unsupported finding, not just malformed JSON — earns exactly one repair turn quoting the rejection verbatim; a second rejection blocks the work item as before.
11. Only the exact passing commit is fast-forwarded to the managed project's local `main`.
12. Hive Mind never pushes, deploys, or submits to an app store.
13. Managed agents receive an allowlisted environment — PATH, provider CLI credentials, standard toolchain locations. Orchestrator secrets — the Discord token above all — are never forwarded to an agent process.
14. The HTTP API and `/ws` accept only a recognized `Host` and same-origin requests, so a page in the operator's browser cannot drive the studio or read its event stream.

## Agent execution authority

Backend Developer and Tester run **unrestricted** inside their managed worktrees — Codex with `--sandbox danger-full-access`, Claude with `--permission-mode bypassPermissions`. They are expected to install, build, and exercise real software, and a sandbox that blocks that produces false failures rather than safety.

The containment is deterministic and applied *after* the fact, not by the sandbox:

- Backend Developer works only in a disposable per-work-item worktree; Frontend Developer then runs in that same checkout, and only their committed result is considered.
- Tester runs in a separate detached worktree; `verifyTesterCheckout` rejects the run if tracked source was modified, if HEAD drifted from the exact commit, or if the checkout is not a registered managed worktree.
- Evidence must resolve inside the managed evidence directory.
- Only the exact passing commit is fast-forwarded to local `main`. Nothing is ever pushed.
- Agents receive an allowlisted environment and never see orchestrator secrets.

**Brain is read-only on every provider** — Codex `--sandbox read-only`, Claude `--permission-mode default`. It converses and plans, it never implements, and it runs with no working directory of its own, which resolves to the Hive Mind checkout itself. Read-only is enforced per provider rather than by trusting that directory, so the planning agent cannot modify this repository regardless of where it starts.

**Frontend Developer currently runs in that same restricted mode**, not the unrestricted one Backend Developer and Tester get: `UNRESTRICTED_ROLES` in [`src/agents/process-agent-gateway.ts`](src/agents/process-agent-gateway.ts) still only lists `developer` and `tester`, a set written before the Frontend role existed. A headless run in restricted mode has no one to grant tool approval, so this looks like an inherited gap rather than a deliberate constraint — worth verifying before relying on Frontend Developer actually editing files in production.

Treat the unrestricted roles as what they are: agents with full local authority on the machine that runs them. The workspace boundary is a Git and filesystem guarantee, not an OS sandbox.

## Supported Tester targets

Plans may request exactly these v1 targets:

- `web` via `npm run test:web` and project-local Playwright
- `ios-simulator` via `npm run test:ios`, Xcode `simctl`, and project-local Appium
- `android-emulator` via `npm run test:android`, `adb`, an Android emulator, and project-local Appium
- `electron` via `npm run test:electron` and project-local Playwright/Electron

Availability is probed in the **exact Tester checkout**, not in this orchestrator repository. Before that checkout exists, the GUI reports readiness as pending. A missing tool, package, script, receipt, or requested target blocks completion rather than silently passing.

Physical devices and Windows remain deferred behind the same driver interface. `ios-simulator` additionally requires Xcode, so it's Mac-only regardless.

## Runtime architecture

- Node.js 22 + TypeScript
- Fastify HTTP/static/WebSocket server
- SQLite operational records
- Local Codex and Claude Code process adapters
- Managed child processes with stdin-only prompts, an allowlisted environment, process groups, heartbeat/activity tracking, inactivity timeout, process-group termination, and bounded restart
- Bounded Brain conversation replay, so a long session does not grow the cost of every subsequent turn
- Managed project repositories and per-work-item Developer/Tester worktrees — Frontend runs in the Developer checkout — or a fixed existing local repository named at plan time instead (see Workspace layout)
- First-run setup gate: the dashboard blocks behind a "Connect your models" screen until every role's configured provider is authenticated (see Setup)
- Disk-space guard: warns once per shortage — not once per tick — when the workspace volume runs low, and re-arms once space recovers
- Backup guard: warns once per lapse when a managed project has uncommitted files or unpushed commits, and re-arms once it's clean
- Optional Discord bridge using the same Brain service as the GUI, plus an optional watchdog for a separate always-on Discord session (see Discord)
- Parent supervisor with backend heartbeat monitoring and bounded restart, runnable standalone or as a macOS LaunchAgent so it survives logout and reboot

Interrupted `building`, `ready_to_test`, and `testing` work returns to the deterministic `ready_to_build` boundary during startup. Persisted `agent_runs` left in `running` are marked `interrupted` with completion metadata before approved work is rescheduled.

## Shared Second Brain

Hive Mind maintains one inspectable, project-scoped knowledge base for Brain, Backend Developer, Frontend Developer, and Tester. It is a bounded orientation layer—not private agent memory and never a replacement for current source, frozen plans, or exact-commit Tester evidence.

- `Atlas` contains exploration, research, questions, and early proposals.
- `Projects` contains active project notebooks.
- `zcomplete` contains shipped or operational notebooks receiving maintenance and bug fixes.
- Brain may create draft Atlas/project notes.
- Backend Developer, Frontend Developer, and Tester submit isolated proposals under `_inbox`; proposals are clearly marked uncurated and cannot overwrite canonical pages.
- Proposals are reviewed by a human in the GUI. Accepting one files a dated page under the project's `decisions` and removes it from `_inbox`; discarding removes it without writing to the notebook. Both are recorded in `LOG.md`.
- Every generated page records source-commit provenance. A commit mismatch produces a stale-knowledge warning.
- Context packs are deterministic, project-isolated, and capped at 48,000 characters, with the most recent entries kept first when a pack is truncated.
- Secret-shaped values in agent-submitted text are redacted on write, and private configuration paths such as `.env` and credential files are excluded. Pages already present on disk are served as written, so redaction is a containment measure rather than a guarantee.

Lifecycle movement changes only the knowledge notebook. Managed Git repositories and worktree paths stay stable.

## Setup

```bash
npm install
cp .env.example .env
npm run check
npm run supervise
```

Open the GUI at `http://127.0.0.1:4401`. If `claude`/`codex` aren't already authenticated for whichever provider each role is configured to use, the dashboard opens on a **Connect your models** screen instead of the studio. It shows exactly which provider is missing, with the CLI login command to run (`claude login` / `codex login`) or a field to paste an API key directly — saved to `.env` and applied immediately, no restart needed. The studio unlocks the moment every configured provider reports ready.

You can also authenticate ahead of time from a terminal:

```bash
codex login status
claude auth status
```

`.env` is ignored by Git. Do not commit credentials.

### Environment

```dotenv
PORT=4401
HIVE_WORKSPACE=/Users/you/HiveMindWorkspace

# Optional Discord bridge — GUI and Discord share one Brain conversation.
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
DISCORD_OWNER_ID=

# Optional: watch a separate always-on Claude Code Discord session and
# auto-repair it if it goes quiet (see Discord below). Unset by default.
CLAUDE_DISCORD_CHANNEL_ID=

# Optional provider CLI overrides. Defaults are `codex` and `claude` from PATH.
HIVE_CODEX_EXECUTABLE=
HIVE_CLAUDE_EXECUTABLE=

# Optional. Only needed if the CLIs aren't already logged in — the Setup
# screen above can also set these for you, live, without a restart.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

If `DISCORD_OWNER_ID` is omitted, bridge authorization is restricted to the configured channel. If present, both channel and owner must match.

Run budget, watchdog cadence, the disk-space warning threshold, and Discord-watchdog tuning are all environment-configurable with sane defaults; see [`src/config/runtime-config.ts`](src/config/runtime-config.ts) for the full list.

## Discord

Two independent, optional surfaces:

- **Bridge** — this backend's own connection to a Discord channel, configured with `DISCORD_BOT_TOKEN`/`DISCORD_CHANNEL_ID`/`DISCORD_OWNER_ID`. The GUI and this channel share the same Brain conversation and workflow records; approvals from either place use the same Backend Developer/Frontend Developer/Tester provider preflight.
- **Always-on Claude Code session** — a separate, standalone `claude` CLI process that answers a Discord channel directly (see [`run-discord-channel.sh`](run-discord-channel.sh)), independent of this backend. If `CLAUDE_DISCORD_CHANNEL_ID` is set, this backend's watchdog watches that channel and, when a human message there goes unanswered past a grace period, restarts the session and posts that it did so.

`POST /api/discord/repair` reconnects the bridge and restarts the always-on session in one call — the GUI's "FIX DISCORD" button calls it. The always-on session's restart step uses `launchctl`/`screen` and is macOS-only; on any other platform it's a documented no-op.

## Commands

```bash
npm run dev         # watch backend during development
npm start           # start backend directly
npm run supervise   # start monitored backend service
npm run typecheck   # TypeScript validation
npm test            # full Vitest suite
npm run check       # typecheck + full tests
npm audit           # dependency vulnerability audit
```

## Main API surface

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/setup/status`
- `POST /api/setup/api-key`
- `GET /api/agents`
- `PATCH /api/agents/:id/settings`
- `PUT /api/agents/:id/soul`
- `GET /api/agents/:id/profile`
- `POST /api/projects`
- `POST /api/projects/:id/work-items`
- `POST /api/work-items/:id/plans`
- `POST /api/plans/:id/approve`
- `POST /api/work-items/:id/retry`
- `POST /api/work-items/:id/cancel`
- `GET /api/brain/messages`
- `POST /api/brain/messages`
- `POST /api/brain/attachments`
- `GET /api/tester/platforms`
- `GET /api/knowledge`
- `GET /api/knowledge/zones/:zone`
- `GET /api/knowledge/zones/:zone/:slug`
- `GET /api/knowledge/note?path=`
- `GET /api/knowledge/inbox`
- `POST /api/knowledge/inbox/resolve`
- `POST /api/knowledge/projects/:slug/lifecycle`
- `POST /api/discord/repair`
- `GET /ws`

The GUI uses `/api/bootstrap` for authoritative state and `/ws` for typed refresh events, with polling fallback.

## GUI

The focused dark/mainframe interface includes:

- a first-run "Connect your models" gate that blocks the studio until every configured provider is authenticated, with CLI login instructions or a paste-your-key fallback for each;
- one shared Brain conversation;
- frozen plan approval and revision controls;
- independent Brain/Backend Developer/Frontend Developer/Tester provider, model, and effort settings;
- workflow and agent state across all four roles;
- acceptance criteria and persisted evidence;
- blocking findings and reproduction details;
- exact Backend/Frontend/Tester/promoted commit identity;
- requested-target readiness;
- blocked-workflow retry;
- Second Brain lifecycle counts, active notebook, and pending proposal count;
- a Second Brain browser for reading Atlas/Projects/zcomplete pages with their provenance, and for accepting or discarding pending role proposals;
- health and event timeline.

There is intentionally no Working Memory or permanent/private per-agent memory. The shared Second Brain is inspectable managed project knowledge with provenance and bounded retrieval.

## Workspace layout

The configured `HIVE_WORKSPACE` contains generated local state, separate from this repository:

```text
projects/          managed project repositories (unless a project names an existing repository instead — see below)
runs/<id>/         Developer checkout (used by Backend and Frontend) and Tester checkout
artifacts/<id>/    agent-produced artifacts
evidence/<id>/     criterion and platform evidence, with commit-scoped subdirectories for exact-commit verdicts
knowledge/         shared Atlas/Projects/zcomplete knowledge and role inboxes
system/database/   SQLite database
system/run-logs/   managed execution logs
system/            supervisor status
```

Generated workspace state is not source code and must not be committed to this repository.

A project can instead point at an existing local Git repository — an absolute path, given once at project creation and fixed after that; Brain cannot change it from chat — rather than living under `HIVE_WORKSPACE/projects/`. Its worktrees, evidence, and knowledge still live under `HIVE_WORKSPACE`, keyed to that project.

## Operational limits

- `npm run supervise` can run standalone, or as a macOS LaunchAgent (`RunAtLoad`/`KeepAlive`) so it restarts on crash and survives logout/reboot.
- The always-on Discord session and its watchdog depend on `launchctl` and `screen`, so they're macOS-only; on any other platform, that half of `/api/discord/repair` is a documented no-op. The Fastify backend itself is plain Node/TypeScript with no other OS-specific dependency.
- Whole-machine dead-man monitoring is not implemented.
- Deployment, remote push, and physical-device testing are outside v1 authorization.
- `ios-simulator` testing requires Xcode and is Mac-only; Windows execution of the studio and its testing tooling generally is untested and unsupported.
- Platform success is impossible until the generated project provides the required local automation package and target script.
