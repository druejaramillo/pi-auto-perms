# Verification

## Local checks

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run lint
```

The test suite uses actual Pi `1.1.0` SDK sessions with isolated temporary
project and agent directories. The extension intercepts actual built-in
`read`, `write`, and `bash` execution, plus registered nested tool calls.
Tests assert tool errors and real filesystem effects, not just a returned
permission enum. External assistant streams and classifier results are
controlled at the model boundary; tests do not spend API credits.

Coverage includes:

- Immediate deterministic allow/deny and reviewer bypass.
- Probability boundaries, choice versus confidence, malformed distributions,
  contradictory answers, exceptions, provider errors, and late responses.
- Explicit provider/model selection for Jev, Clef, Clef Flash, and Decisions.
- Uncertain actions waiting for a genuine user reply, extension-generated
  messages excluded, bounded history, and the latest refusal reaching review.
- Written approval linked to the assistant's preceding question and exact
  retry, without fabricating a high-probability verdict when review stays unsure.
- One-use `/auto-perms approve` overrides of reviewer denials, agent resumption,
  identical/reordered versus changed arguments, and repeated-call consumption.
- Manual override invalidation on reload, trust changes, and new user input;
  deterministic denials preserved; credential-bearing arguments hashed without
  provider submission or argument-bearing decision metadata.
- Clear denials allowing independently permitted alternatives.
- Trusted overrides of tool, protected-path, and directory-boundary denials;
  additive/replaced semantic rules; untrusted policy ignored; revoked trust.
- Invalid configuration, explicit reloads, and rejection of in-flight
  approvals after a reload or new user instructions.
- Symlink aliases, native `@` paths, NFD/curly-quote/screenshot filename
  fallbacks, command chains, shell redirection, formatter preview versus
  apply, and nested writes through an allowed orchestrator.
- Inline-credential submission blocked and oversized required evidence not truncated.
- Inspected script source, completed script writes, and current assistant rationale
  reaching later script/compound-command reviews without becoming user consent.
- Task history respecting active branches, compaction, context edits, whole-entry
  limits, remaining review space, and a global opt-out/disclosure budget.
- Historical credentials omitted, thinking/images/custom context excluded, failed
  calls labeled, and injected source instructions kept as untrusted tool evidence.
- YOLO global/session/CLI controls, restoration of deterministic and classifier
  enforcement, project mode selection rejected/ignored, and stale approvals
  invalidated after mode changes.
- YOLO execution of denied shell commands and nested external writes without
  reviewer calls, with argument-free YOLO decision metadata.
- Session overrides preserved across policy reloads and cleared by extension
  reloads; explicit session/CLI YOLO bypassing invalid policy.

## Herdr event-bus checks

`src/permission-herdr.test.ts` binds real Pi SDK sessions in TUI, RPC, JSON,
and print modes. Its 22 cases observe the existing `herdr:blocked` event
contract without contacting a Herdr server. They cover:

- Uncertain reviews staying blocked after agent settlement, retries, and
  deterministic inspection; extension-generated messages do not resolve waits.
- Genuine user input clearing the status, fresh refusals reacquiring it, and
  successful one-use overrides resuming the agent without changing review rules.
- Deterministic/reviewer denials and configuration/provider failures; permitted
  alternatives resolving definite denials without approving the denied action.
- Policy/mode/session resets and extension reloads releasing exactly one owned
  block, without consuming another extension's blocking prompt.
- Static argument-free labels, no events for ordinary allowances, and no TUI
  status events from headless modes.

The installed Herdr Pi integration v9 was inspected to confirm that it listens
to this hook, counts active blockers, and gives them priority over idle status.
Execution of that managed extension and its socket reporting was not tested.

## Installed Pi startup smoke

The extension was also loaded by the installed Pi `1.1.0` executable with
an isolated empty home/agent directory, no inherited credentials, no other
extensions or project resources, offline startup, and an in-memory session.
The explicit `/auto-perms` command exited successfully with no stderr.
The same isolated startup checks cover `/auto-perms yolo on`,
`/auto-perms yolo off`, and `--auto-perms-yolo`; help output lists the flag.
This checks real extension-file loading and command/flag registration, not
classifier quality or tool execution in the CLI. `/auto-perms approve` is also
checked with no pending invocation: it loads and returns without a model call.

Equivalent invocation, in a shell with an isolated credential-free environment:

```sh
pi --offline --no-extensions --no-skills --no-prompt-templates \
  --no-themes --no-context-files --no-approve --no-session \
  --extension ./src/auto-perms-extension.ts \
  --model anthropic/claude-sonnet-4-5 --print /auto-perms
```

An explicit chat-model selection avoids relying on credential-backed model
availability. No chat or classifier request is needed for this command.
Print mode has no notification UI, so success is exit status, not status text.
The machine's mise launcher rejected the temporary home; the actual installed
Pi executable was invoked directly for the successful smoke check.

## Not yet verified

- Live authenticated calls to the three providers, their account access,
  probability calibration, real latency, token use, or billing behavior.
  Controlled fixtures prove approval/task-context delivery and override enforcement,
  not that live Jev reliably recognizes consent, understands scripts, resists
  injected source instructions, or improves its allow scores. The richer context
  and effect-based instructions still need a live safe/unsafe evaluation corpus;
  low-confidence allow decisions remain blocked at the configured threshold.
- Herdr's managed extension execution, socket delivery, and sidebar/CLI status.
  Herdr verification covers its inspected v9 hook and Pi event-bus behavior;
  the optional managed-integration smoke test was skipped.
- Real MCP servers and the built-in codemode runtime. Nested calls are
  exercised through the public `ctx.executeTool()` SDK path, not every host
  integration that might call tools.
- Windows/PowerShell behavior or protection against arbitrary extension code,
  malicious tool implementations, opaque shell scripts, prompt injection,
  unlisted filename-resolution aliases, or filesystem changes after evaluation.

Permissions are enforced at Pi's tool-call hooks, not the OS boundary.
Additional extensions must load successfully and follow those hooks.
Always check startup errors and confirm `/auto-perms` is registered before
relying on the extension. Hosted-provider validation requires credentials
and explicit spending approval; none was used for these checks.
