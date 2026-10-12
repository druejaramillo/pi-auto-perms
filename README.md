# pi-auto-perms

A planned [Pi](https://pi.dev) extension for reviewing tool permissions with
System One decision models and plain-language policies.

## Status

Standalone implementation in progress. Deterministic gates and classifier
approval now run in real Pi SDK integration tests. There are no permission
dialogs: uncertain reviews block and tell the agent to ask the user in chat.
No active Pi configuration has been changed.

## Goal

Reduce repetitive permission prompts without turning uncertainty or a provider
outage into permission to execute a tool.

The requested capabilities are:

- Plain-language permission rules in global and project configuration files.
- Configuration-driven reviewer selection: TypeSafe Jev, Cloudflare Clef or
  Clef Flash, or OpenAI Decisions.
- Narrow deterministic bypasses for explicitly permitted operations.
- Probability thresholds for automatic decisions.
- Agent-visible denials that explain the deciding rule or review failure.
- Coverage of built-in, extension, MCP, and nested tool calls through Pi's
  permission hooks.

These are goals, not implemented guarantees. A model review is not an
operating-system sandbox, and its probability is not a security guarantee.

## Research

See [permission-system research](docs/permission-system-research.md) for the
existing integration seams, provider contracts, proposed configuration, and
remaining decisions.

## Completion checks for implementation

- A deterministic bypass makes no classifier request, while hard denials remain
  enforced.
- Automatic approval requires a valid response meeting the configured policy and
  threshold; a failed, refused, malformed, or uncertain review never auto-allows.
- A blocked tool causes no execution side effect and returns a useful reason.
- Untrusted project policy cannot silently change approval authority or redirect
  credentials.
- Tests cover configuration merging, threshold boundaries, all requested
  providers, and failure behavior; a live Pi check exercises direct and nested
  tool calls.

Provider access, live API spending, installation, and npm publication are separate
from local implementation. No paid classifier requests have been made.
