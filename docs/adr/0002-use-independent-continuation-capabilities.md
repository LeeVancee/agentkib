# Use Independent Continuation Capabilities

AgentKib models continuation as seven independently reported capabilities: source reading, source parsing, native resume, file handoff, windowed context, MCP setup, and interactive launch. Each capability uses one of four states—supported, unavailable, unsupported, or unverified—so the UI can distinguish verified support from missing local prerequisites, absent agent features, and behavior that has not yet been validated.
