# Distinguish Native Continuation from File Handoff

AgentKib distinguishes native continuation from file handoff. Native continuation is limited to cases where the target agent recognizes its own native session state through an official resume capability; a file handoff always starts a new session and must not be presented as restoration of the source agent's native state.
