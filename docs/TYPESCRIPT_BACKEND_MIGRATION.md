# TypeScript Backend Migration

Status: approved for implementation on `codex/typescript-backend-spike`.

This document records the decisions made before replacing AgentKib's Rust backend. It is the source of truth for scope, architecture, migration order, and cutover criteria.

## Outcome

- Replace all first-party Rust backend code with an idiomatic TypeScript backend.
- Add a private pnpm workspace package named `@agentkib/backend`.
- Run the backend in one Node worker thread bundled with the Electron application.
- Keep the current renderer-facing `window.agentkib` interface, IPC channels, payload shapes, error semantics, and observable UI behaviour.
- Preserve every currently supported desktop platform.
- Perform one final cutover. Released code must not contain a Rust fallback or a dual-backend router.
- Remove the unpublished `agentkib-cli`; its reusable capabilities remain available through the backend package.
- Remove all first-party Cargo workspaces, crates, Rust runtime binaries, JSON-RPC runtime hosting, protocol generation, and runtime staging.

## Non-goals

- Redesigning the UI or renderer interface.
- Renaming existing `snake_case` response fields.
- Changing product rules while translating their implementation.
- Changing SQLite schema version 10.
- Supporting browsers, old Node releases, or Electron versions older than the current Electron 44 baseline.
- Publishing `@agentkib/backend` to npm.
- Replacing the third-party CodexBar quota collector.

## Runtime architecture

```text
React renderer
      | existing Electron IPC
      v
Electron main
      | typed worker messages
      v
@agentkib/backend worker
      |
      +-- SQLite
      +-- filesystem and Git
      +-- discovery and sessions
      +-- insights and storage
      +-- MCP Hub and managed child processes
      +-- remote gateways
      +-- quota collector
```

`@agentkib/backend` is a deep module. Electron depends on its small request interface and does not know about repositories, parsers, process supervision, or domain internals. The worker transport is an adapter at that seam, not the backend's implementation model. A future CLI may call the same module directly or provide another adapter.

The backend package must not depend on Electron. Electron main owns windows, dialogs, updates, the tray, `shell.openExternal`, system settings, and visible application or terminal launches. The backend owns data, validation, filesystem access, network work, headless subprocesses, MCP runtimes, and quota collection. For visible desktop actions, the backend returns a validated action plan and Electron main executes it.

## Package layout

The exact internal files may evolve, but responsibilities must remain local to these modules:

```text
packages/backend/
  package.json
  tsconfig.json
  src/
    index.ts
    contracts/
    worker/
    platform/
    store/
    workspace/
    changes/
    discovery/
    conversations/
    git/
    insights/
    quota/
    storage/
    mcp/
    gateways/
    obsidian/
```

Internal seams are allowed for platform adapters and true external dependencies. Internal repositories and helpers must not leak through the external backend interface merely to make testing convenient.

## Data contracts

- Zod is the single source of truth for backend method inputs, outputs, notifications, and structured errors.
- Worker client types are inferred from the same schemas used for runtime validation.
- Untrusted IPC input, disk JSON, third-party command output, and network responses are validated at entry.
- Existing renderer method names and IPC channels remain unchanged.
- Existing serialized field names, optional fields, null behaviour, ordering where observable, timestamps, identifiers, and error meanings remain compatible.
- Rust-generated `runtime-protocol.ts` is removed after the final TypeScript contract covers every method.

## Persistence

- Use Electron 44's Node 24 runtime and built-in `node:sqlite` implementation.
- Continue using the existing production and development data directories.
- Open the existing `agentkib.db` directly with WAL, foreign keys, busy timeout, FTS5, and schema version 10 behaviour preserved.
- Do not add a schema migration merely for the language change.
- Preserve `preferences.json`, `remote-gateways.local.json`, `.agentkib` files, MCP configuration, backups, session indices, and quota configuration.
- Before the first TypeScript-backed production startup, create a recoverable backup of persisted AgentKib data.
- A database written by the TypeScript release must remain readable by the preceding Rust release.

## Concurrency and lifecycle

- One worker owns backend state, the SQLite connection, MCP Hub state, and managed child-process state.
- Serialize SQLite writes with transactions.
- Permit independent reads and I/O to overlap where safe.
- Use single-flight execution for discovery, insights, quota, storage, and other refresh classes that must not overlap with themselves.
- Propagate `AbortSignal` through long-running work.
- Preserve the existing refresh coordinator's observable behaviour.
- Worker shutdown or failure cancels scans, rejects pending requests, closes servers and SQLite, and terminates managed process trees.
- Electron may restart a failed worker with bounded backoff, but must surface a crash loop instead of retrying forever.

## Filesystem and process safety

- Reproduce canonical path and allowed-root checks before reading or writing sensitive targets.
- Reject symlink escapes and path traversal.
- Verify expected file contents or hashes before applying a planned change.
- Write through a same-directory temporary file, flush, and atomically rename.
- Apply restrictive permissions to secret-bearing local configuration.
- Validate every operation in a multi-file ChangeSet before writing; restore already changed files from backup if the apply fails.
- Never silently weaken safety checks for Windows, network filesystems, or unusual mounts.
- Resolve executables explicitly and pass argument arrays without shell interpolation.
- Terminate full managed process trees during cancellation and shutdown.

## Errors and privacy

- Use a stable structured `BackendError` with a code, safe message, and optional validated details.
- Normalize validation, filesystem, SQLite, process, network, cancellation, conflict, and timeout failures.
- Preserve error meanings currently observed by the renderer.
- Never send stacks, tokens, headers, environment variables, raw provider bodies, or complete session contents to the renderer.
- Development may log local stacks to stderr. Production diagnostics must redact secrets and sensitive paths or content.
- Do not add telemetry or automatic uploads.

## MCP

- Replace Rust `rmcp` with the official TypeScript MCP SDK.
- Retain AgentKib's configuration model, secret masking, native-config migration, registry cache, OAuth behaviour, runtime status, process supervision, network settings, LAN safety restrictions, and built-in tools.
- Keep SDK-specific code inside an MCP transport adapter so SDK upgrades do not spread across the backend.
- Preserve stdio, Streamable HTTP, required legacy fallback, and OAuth behaviour used by current installations.

## Dependencies

- Use pnpm for all JavaScript and TypeScript package operations.
- Prefer Node built-ins: `fs`, `path`, `child_process`, `crypto`, `fetch`, `node:sqlite`, streams, and worker APIs.
- Add only Zod, the official MCP SDK, and mature YAML, TOML, and JSON5 parsers where required.
- Do not introduce an ORM, Git wrapper, dependency-injection framework, job-queue framework, or general RPC framework.
- Pin and license-check every new production dependency.

## Quota collector exception

The CodexBar and Win-CodexBar collector remains a third-party native tool bundled with AgentKib. It is not the AgentKib backend.

- Keep quota feature and payload compatibility on every supported platform.
- Keep fixed upstream versions and checksum verification.
- macOS and Linux continue to obtain verified upstream collector artifacts.
- Windows downloads a fixed official Win-CodexBar installer, verifies its SHA-256, extracts `codexbar-cli.exe` into a temporary directory, smoke-checks it, and stages it under AgentKib's collector name.
- Do not commit large generated collector binaries.
- Windows 11 ARM64 may run the upstream x64 CLI through system x64 emulation.
- Missing, mismatched, unextractable, or non-working collector artifacts fail release packaging rather than silently dropping quota support.
- AgentKib's CI and release pipeline must not install or execute Cargo or Rust for quota preparation.
- Replace the Rust-built Windows ARM NSIS launcher with a solution that does not require a Rust toolchain.

## Supported platforms

The migration must retain the current release matrix:

- macOS arm64 and x64.
- Windows x64 and Windows ARM64 preview.
- Ubuntu x64 and Ubuntu ARM64 preview.
- Fedora x64.

Platform differences belong in `platform/` adapters. They must not be scattered through domain modules.

## Verification strategy

Adding and porting necessary backend tests is explicitly approved.

- Test through the backend module's external interface rather than internal implementation details.
- Port high-value Rust behaviour tests and fixtures for store migrations, paths, atomic writes, ChangeSets, manifests, context resolution, doctor checks, discovery, conversations, Git, insights, storage, quota, MCP configuration, gateways, and Obsidian integration.
- Run differential fixtures against the Rust and TypeScript implementations before deleting Rust.
- Keep existing renderer tests unless behaviour intentionally remains unchanged and the existing test is obsolete for unrelated reasons.
- Use copied or temporary data only; never run migration verification against the user's live production database.

## Implementation order

Implementation is incremental inside the branch, while product cutover remains atomic:

1. Inventory every runtime method, notification, persistent file, database table, and platform-specific operation.
2. Add the pnpm backend package, contracts, error model, direct backend interface, worker host, and worker client.
3. Port platform primitives, SQLite store, domain models, workspace scanning, manifests, context, doctor, ChangeSets, adapters, and Git.
4. Port discovery, conversations, insights, storage, and quota orchestration.
5. Port MCP, gateways, Obsidian, managed process supervision, and remaining runtime composition.
6. Bind the worker client to existing Electron main IPC handlers without changing renderer behaviour.
7. Run differential and packaged parity checks while Rust remains available only as a development oracle.
8. Switch Electron startup to the TypeScript worker and remove all Rust/runtime infrastructure in the same cutover change.
9. Update documentation, CI, release workflows, diagnostics, licenses, and staging scripts.

## Cutover gates

Rust may be deleted only when all gates pass:

- Every existing runtime method has a real TypeScript implementation; no unsupported placeholders remain.
- Required Rust fixtures and TypeScript observable outputs match.
- A copied schema 10 production database opens and works without reset or rescan.
- The preceding Rust release can still read data written by the TypeScript release.
- `pnpm` formatting, linting, type checking, backend tests, frontend tests, and builds pass.
- Every release-platform package builds and passes its startup smoke check.
- Discovery, storage, insights, sessions, MCP, quota, handoff, gateways, and Obsidian each pass manual acceptance.
- Electron main remains responsive during long scans.
- Worker cancellation, restart, shutdown, and managed process cleanup are verified.
- The repository, CI, and release pipeline no longer require Cargo or Rust.
- Only the approved third-party quota collector native artifact remains.

## Progress checklist

- [x] Runtime and persistence inventory complete.
- [x] `@agentkib/backend` package and contracts established.
- [x] Worker transport and lifecycle established.
- [x] Platform and store modules ported.
- [x] Workspace, changes, adapters, doctor, and Git ported.
- [x] Discovery and conversations ported.
- [x] Insights, storage, and quota ported.
- [x] MCP, gateways, and Obsidian foundational services implemented; OAuth, registry/install flows, and full remote parity remain.
- [ ] Electron IPC bound to TypeScript backend (worker host adapter and opt-in `AGENTKIB_TS_BACKEND=1` startup path are ready; Rust remains the default).
- [ ] Cross-platform packaging updated.
- [ ] Parity and acceptance gates passed.
- [ ] Rust and Cargo removed.
