# AgentKib Conversation Continuity

This context defines the domain language for discovering, reviewing, and continuing locally stored AgentKib conversations across coding agents.

## Language

**Native continuation**:
Continuing a conversation in a target agent's own recognized session state through that agent's official resume capability. It preserves the meaning of a native session rather than merely supplying copied conversation content.
_Avoid_: File handoff, transcript import, restored session when only a handoff artifact is available

**File handoff**:
A user-reviewable artifact that transfers selected conversation context to a new target-agent session. It is a new session and must not be described as restoration of the source agent's native state.
_Avoid_: Native continuation, session restoration

**Continuation capability**:
One independently verifiable ability involved in discovering, interpreting, transferring, resuming, or launching a conversation across agents. A target agent may have some capabilities without having native continuation.
_Avoid_: Supports handoff as a single undifferentiated status

**Capability matrix**:
The set of continuation capabilities reported for a specific source agent, target agent, platform, and environment. It is the authority for which continuation actions AgentKib may present.
_Avoid_: Agent-name inference, universal capability status

**Supported**:
A continuation capability that has been verified and is usable in the reported environment.

**Unavailable**:
A continuation capability that exists in principle but cannot be used in the reported environment because a prerequisite is missing or blocked.

**Unsupported**:
A continuation capability that the relevant agent does not provide.

**Unverified**:
A continuation capability whose behavior or data format has not been validated sufficiently for AgentKib to offer it as supported.

**Metadata-only session**:
A discovered conversation for which identifying metadata is reliable but the conversation content cannot be safely read or interpreted. It may be shown for awareness but cannot be continued or exported.
_Avoid_: Partially readable session, resumable session

**Session loss**:
An explicit record that some source conversation content or structure cannot be preserved in the target representation. Every loss is reported with its category and count before a continuation is applied.
_Avoid_: Silent omission, harmless drop

**Sanitized handoff content**:
Conversation content after AgentKib has removed recognized sensitive values and before it is written to a target agent or a handoff artifact. Sanitization is applied again after user edits and before writing.
_Avoid_: User-approved unsanitized content, one-time redaction

**Windowed context**:
The active portion of a conversation selected to fit the target agent's history budget while preserving a controlled reference to older content.
_Avoid_: Silent truncation, incomplete transcript

**Controlled archive**:
A protected, workspace-scoped representation of conversation content deferred from the active window and available only through the approved continuation path.
_Avoid_: Cloud backup, unrestricted transcript copy

**Continuation approval**:
The user's explicit authorization to apply a reviewed continuation change, including any separate authorization required for Agent Home access. Previewing or planning a continuation is not approval.
_Avoid_: Preview consent, implicit write permission

**Continuation outcome**:
The user-visible result of applying and launching a continuation: not applied, applied but launch failed, or launched successfully. A written continuation whose target agent did not start is not a successful launch.
_Avoid_: Process spawned equals success, applied equals launched

**Platform-scoped capability**:
A continuation capability whose status is determined for a particular operating system, architecture, agent version, and local environment. Support on one platform does not imply support on another.
_Avoid_: Cross-platform assumption, universal support claim

**Excluded private state**:
Sensitive or execution-bearing source information that must not cross the continuation boundary, including credentials, hidden reasoning, shell initialization, unrelated private configuration, and unfinished tool actions.
_Avoid_: Recoverable context, completeness requirement

**External attachment**:
An attachment referenced by a conversation but stored outside the safely managed continuation content. Its path or contents are not copied across the boundary.
_Avoid_: Portable attachment, automatically restored attachment

**Unsupported attachment**:
An attachment whose format or representation cannot be safely preserved for the target agent. It is reported as a session loss rather than silently discarded.
_Avoid_: Ignored attachment

**Verified capability**:
A continuation capability whose required evidence has been recorded for the relevant agent, version, platform, and environment. Only a verified capability may be presented as supported.
_Avoid_: Implemented capability, assumed support

**Editable file handoff**:
A complete, non-windowed file handoff that the user may revise before it is written, while all safety checks and sanitization remain enforced.
_Avoid_: Editable native session, editable windowed context

**Validation record**:
A sanitized account of a continuation capability check that identifies the agents, versions, platform, mode, evidence, outcome, losses, and fallback without containing secrets or personal conversation content.
_Avoid_: Process-start log, unsupported support claim
