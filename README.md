# pi-auto-perms

A standalone [Pi](https://pi.dev) extension that replaces permission dialogs
with System One decision-model reviews.

Deterministic rules still allow or deny immediately. `ask` means **review**,
not a dialog. An uncertain or failed review blocks execution and tells the
agent to ask the user in chat. Written approval is the normal flow: the reviewer
considers the reply alongside the agent's question and the blocked invocation.
Approval supplies consent within its stated scope, not a blanket safety bypass.
`/auto-perms approve` is an explicit, one-use reviewer override when needed.

## Status

Experimental `0.1.0`, tested with Pi `1.1.0`. The integration suite runs real
Pi SDK sessions and checks tool outcomes and filesystem effects. External
model responses are controlled fixtures: live provider quality, latency,
and probability calibration have **not** been verified.

No active Pi configuration is changed by this repository. There is no
runtime dependency on `@gotgenes/pi-permission-system`.

## How it works (default review mode)

1. Check tool, path, external-directory, and shell policies.
2. Execute deterministic allowances; block deterministic denials.
3. Send remaining actions to the explicitly configured classifier through
   Pi's `modelRegistry.classify()` API.
4. Execute only a valid `allow` whose probability meets the threshold.
   Conflicting or malformed answers, timeouts, provider errors, and oversized
   evidence block execution.
5. On uncertainty, stop further reviewed actions until a new genuine user
   message arrives. Give the agent instructions to ask and wait, not a
   permission dialog. Deterministic inspection remains available.

Small two-decimal rounding discrepancies are tolerated without renormalizing
probabilities, changing the selected choice, or lowering the approval threshold.
See [response validation](docs/configuration.md#global-settings) for the exact bounds.

Reviews include exact tool arguments, the declared tool description,
working directory, effective rules, recent genuine user messages, the assistant
message preceding the latest reply, a bounded previously blocked action, and
bounded task context from recent assistant explanations and completed tool
observations. Inspected script source and previously written code can therefore
inform a later script invocation, instead of reviewing only `bash script.sh`.

The reviewer is told that policy `ask` entries route review, not establish
missing consent. It assesses actual effects and task scope, not hypothetical
executable capabilities: compound commands, heredocs, and Python/bash scripts
are not inherently dangerous. It still evaluates every reachable step and
preserves applicable denials, refusals, and concrete unresolved risks.
Assistant/tool context is untrusted evidence, never consent or policy.

Task history retains at most 12 recent whole observations within an 8,192-character
default budget and the remaining total review budget. Set global
`maxTaskContextChars` to `0` to disable it. Oversized or credential-bearing
historical entries are omitted with omission metadata; current arguments,
policy, and authorization evidence are never shortened to make room.
The agent is instructed to explain nontrivial commands and inspect unseen
script source through normally permitted tools before invocation.

Extension-generated messages do not count as user approval. Reloaded policy,
changed user context, changed arguments, or revoked project trust invalidate
an in-flight approval. Written consent still needs a qualifying reviewer verdict;
a mistaken refusal can be overridden explicitly, without lowering the threshold.

## Herdr status integration

This extension uses the existing `herdr:blocked` event-bus hook in Herdr's
managed Pi integration (confirmed in integration v9). It does not call the
Herdr CLI/socket directly or modify Herdr's extension. Load both extensions;
if needed, install Herdr's integration with `herdr integration install pi`.

In Pi's TUI, a blocked tool reports **blocked**, with the label "Waiting for
permission", rather than **done** when the agent finishes asking in chat.
An uncertain review keeps that status through retries, extension-generated
messages, and deterministic inspection. Genuine user input clears the status,
not the permission checks; a fresh refusal marks it blocked again.

A successful `/auto-perms approve`, policy reload, mode change, or session
shutdown/reset also clears the wait. After a definite denial, an independently
permitted alternative can clear it without requiring approval of the denied
action. Events are balanced so cleanup cannot clear another extension's
blocking prompt. Labels never include tool arguments or proposed file contents.

No extra dependency or permission configuration is required. Without Herdr's
listener, the events have no effect; RPC, JSON, and print modes do not emit them.

## One-use reviewer override

Normally, answer the agent in chat. If review still refuses the action, use:

```text
/auto-perms approve
```

This deliberately bypasses the reviewer, its semantic denials, and review
failures for **only the last reviewer-blocked tool invocation**, with identical
arguments. Pi resumes the agent to retry it; the command does not execute the
tool directly. The override is consumed once, does not authorize changed
arguments or other tools, and never bypasses deterministic denials or other
extensions. New user input, policy/context changes, and an unused completed
retry turn clear it. See [override details](docs/configuration.md#one-use-reviewer-override).

## YOLO mode

YOLO is **off by default**. It bypasses every permission gate, including
protected-path and shell denials, without contacting a reviewer.

```text
/auto-perms yolo on
/auto-perms yolo off
```

Or start with `pi --auto-perms-yolo`, or set `"mode": "yolo"` in the global
`auto-perms.json`. Project JSON cannot select this mode. Session commands
never edit configuration; `off` overrides a global/CLI YOLO default for the
current session. Policy reload preserves that override; a new session or
extension reload returns to the configured/CLI default.

YOLO also skips credential/evidence guards and chat-approval waiting. It
cannot override other extensions, tool availability, OS permissions, or user
instructions. Pi displays a YOLO warning/status, and decision entries record
`source: "yolo"`. See [mode controls](docs/configuration.md#yolo-mode) for details.

## Reviewers

Choose the provider and model in configuration, independently of which
credentials happen to exist:

| Provider | Model |
| --- | --- |
| `typesafe` | `jev-latest` |
| `cloudflare-workers-ai` | `@cf/cloudflare/clef` |
| `cloudflare-workers-ai` | `@cf/cloudflare/clef-flash` |
| `openai` | `gpt-6-luna` |

Credentials stay in Pi's authentication system, not in permission files.
OpenAI Decisions needs API-key authentication; a ChatGPT/OAuth login is not
sufficient. See [configuration](docs/configuration.md) for setup details.

## Try locally

Requires Pi `1.1.0` or later and Node `22.19.0` or later for development.

```sh
npm ci --ignore-scripts
pi --no-extensions --extension ./src/auto-perms-extension.ts
```

`--no-extensions` disables the old permission extension for **that run**;
explicitly supplied extensions still load. Configure reviewer credentials
before attempting reviewed operations. Using a hosted reviewer may incur
provider charges.

For permanent installation:

```sh
pi install git:github.com/druejaramillo/pi-auto-perms
```

Disable the old permission extension with `pi config` before using this
one. Loading both is not replacement: the old extension can still deny or
open dialogs. Restart Pi or reload its extensions after changing packages.
The package is intentionally private for npm publication; Git installation
is supported.

## Configuration

- Global: `~/.pi/agent/auto-perms.json`, or the active Pi agent directory.
- Trusted project: `<cwd>/.pi/auto-perms.json`.
- `/auto-perms`: show configuration in Pi's UI, not an API connection test.
- `/auto-perms approve`: override the last reviewer-blocked invocation once.
- `/auto-perms reload`: explicitly load a fresh policy snapshot.
- `/auto-perms yolo on|off`: override the permission mode for this session.

Project policy may override **any** global or built-in policy rule. Matching
semantic rule IDs replace inherited rules; new IDs add rules. Permission
maps merge in project patterns with last-match precedence. Permission mode,
reviewer selection, and runtime limits are global-only configuration fields.

Start with [the global example](examples/global-auto-perms.json) and
[the project example](examples/project-auto-perms.json). See
[configuration and merge semantics](docs/configuration.md) before copying
rules from another permission system; this is not its complete config schema.

## Safety and data flow

This is a probabilistic decision layer, **not an OS sandbox**. Trusted
extensions, custom tool implementations, scripts, and RPC clients remain
trusted code. Do not treat a tool's name or read-only annotation as proof
that its implementation has no side effects.

Deterministic allowances bypass semantic review and chat context. Keep them
narrow. The selected reviewer receives full arguments, including proposed
file contents, recent user text, the assistant message preceding the latest
reply, and bounded recent assistant/tool text, which can include source code
and command output. A conservative guard blocks obvious inline credentials
in required evidence and omits credential-bearing supplemental history, but
it is not complete secret detection. Choose the reviewer with your code and
data policies in mind; disable task history if needed. Do not put credentials
in prompts or permission files.

Project overrides have full policy authority once the project is trusted.
There are no immutable global denials. Trusting a project is consequential,
not a sandbox boundary.

## Development

```sh
npm test
npm run check
npm run lint
```

See [verification and remaining limitations](docs/verification.md).
[Permission-system research](docs/permission-system-research.md) records the
initial investigation; the implementation and configuration guide are the
current contract.
