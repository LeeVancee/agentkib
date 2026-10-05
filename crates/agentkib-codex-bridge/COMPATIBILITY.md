# Verified protocol surface

The opt-in basic follower requires macOS Desktop `26.917.62051` or newer;
thread settings require `26.924.22138` or newer. Desktop versions must contain
exactly three numeric components, compared numerically as a tuple against each
minimum. Versions below the applicable minimum or with an invalid format fail
closed. Meeting a minimum permits runtime compatibility checks; it is not evidence
that the installed version has passed real owner-control acceptance.
VS Code extension `26.908.40401` was also present for the protocol inspection.
The OS-verified IPC peer executable determines the Desktop bundle root, including
relocated installations and user Applications. Extension metadata is diagnostic,
not a prerequisite for a Desktop-owned session. The socket resolves from CODEX_HOME
(or the normal ~/.codex fallback), without copying or replacing it.

On 2026-09-24 the installed Desktop ASAR's method map was inspected without
executing application code. Its `.vite/build/src-DldfpmrL.js` declares stream-state
11, following/discovery/approval/user-input 1, start-turn 2, and interrupt-turn 4.
The Desktop main and renderer owner handlers retain conversation-targeted start,
expected-turn interruption, and typed approval/user-input response routing.
The bridge continues to validate the OS-verified peer, exact method versions,
owner, host, thread, revision and complete approval details at runtime, failing
closed on mismatch. Control requires a matching native ACK; a timeout or lost
receipt remains unknown and blocks subsequent control until reconciled. A newer
Desktop version does not relax these checks or clear an unknown-result fence.

On 2026-09-27 Desktop `26.924.22138` build 11645 was inspected from its packaged
ASAR. Its owner map retains the verified basic methods and adds
`thread-follower-update-thread-settings` version 2. The owner serializes this
mutation, checks the supplied model/effort condition, applies settings for the next
turn, and returns an explicit `applied` boolean. This inspection establishes the
`26.924.22138` minimum for that method; its method version remains exactly 2.

The currently installed Desktop `26.930.51102` has been statically inspected for
the method map and key payload fields only. It meets both Desktop minimums, but
real owner-control and end-to-end acceptance have not been run for this version.
The historical acceptance evidence below remains specific to the versions and
operations tested.

Managed execution is a separate app-server protocol. Its allowed CLI builds are
`0.155.1` and Desktop's `0.155.0-alpha.16.3`. Both upstream source tags contain the
same `rollout/src/writer_lock.rs` and `thread-store/src/local/live_writer.rs`:
resume acquires a native per-thread writer lock within the same CODEX_HOME.
AgentKib must never remove, acquire itself, or recreate those native lock files.
An owner-discovery miss does not establish exclusive ownership.

Protocol source:
https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/rollout/src/writer_lock.rs
https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/thread-store/src/local/live_writer.rs


On 2026-09-26 the same two real app-server builds passed isolated, offline
completion and approval fixtures. Evidence covers clientUserMessageId preservation,
expectedTurnId steering rejection, queue mutation/automatic consumption, rename
readback, next-turn settings, local image input, fork/archive/unarchive plus explicit
resume, exact command-rule and permission responses, and serverRequest/resolved
for approvals and secret/custom answers. A loopback model supplies synthetic tool
calls; no user account credentials or existing threads are used.

Correction, 2026-09-27: app-server has no supported `thread/settings/update`
request. Managed settings are durable next-turn selections, passed explicitly to
`turn/start`; only native settings events/readback establish applied state.
The experimental `0.155.1` schema does provide `collaborationMode/list` and
`turn/start.collaborationMode`. A null `developer_instructions` loads Codex's
built-in mode instructions. Model and effort must agree in both the top-level
request and collaboration mode. AgentKib does not supply plan instructions.

The isolated native Plan/Goal fixture uses a temporary CODEX_HOME, workspace and
loopback model. It checks Plan/default switching, native questions, goal state and
budget behavior, and restart readback. Managed Plan is enabled for `0.155.1` only;
the older base-supported alpha has not passed this added mode fixture. See
`qa/codex-native-plan-goals-2026-09-27.md` for exact evidence and limits.

These app-server results do not enable equivalent Desktop follower methods.
Follower advanced queue/settings/organization/expanded-approval operations remain
unverified and unavailable except for the owner method
`thread-follower-update-thread-settings` version 2 on Desktop `26.924.22138` or
newer. That method is limited to the validated model, effort, service tier,
collaboration mode and three mapped
permission profiles; the owner must return `{applied:true}`. The follower stream
does not provide the target host's model/service-tier catalog, so AgentKib exposes
only collaboration mode and the three fixed permission profiles through Web; it
rejects browser model, effort and service-tier strings instead of guessing a
catalog. Host defaults also cannot be read reliably, so restore-default remains
unavailable. Existing basic follower control remains version- and owner-checked.
The shared input primitive also preserves request identity and rejects attachment
path aliases; its local transport test is not a new production follower attachment
acceptance claim. Manual queue start and worktree/branch mutations remain disabled
without a verified native success path.

The inspected `26.924.22138` bundle contains CLI `0.158.0-alpha.2.1`. Its isolated
Plan/Goal fixture was also run, but that CLI is not in the managed-execution
allowlist. Managed execution remains pinned to `0.155.1` and
`0.155.0-alpha.16.3` until its existing isolated protocol suite is repeated for a
new build.

The real `26.924.22138` owner was separately tested on the user-designated safe
chat: default → plan → default, each with an applied receipt and fresh owner
snapshot. Its original mode/model/effort were restored and no turn was started.
This validates the owner bridge, not mobile UI synchronization or a real dual-end
race; transport fixtures separately cover stale conditions and running rejection.
No verified follower Goal method exists, so official-session Goal stays unavailable.
