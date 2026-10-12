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
- Clear denials allowing independently permitted alternatives.
- Trusted overrides of tool, protected-path, and directory-boundary denials;
  additive/replaced semantic rules; untrusted policy ignored; revoked trust.
- Invalid configuration, explicit reloads, and rejection of in-flight
  approvals after a reload or new user instructions.
- Symlink aliases, native `@` paths, NFD/curly-quote/screenshot filename
  fallbacks, command chains, shell redirection, formatter preview versus
  apply, and nested writes through an allowed orchestrator.
- Inline-credential submission blocked and oversized evidence not truncated.

## Installed Pi startup smoke

The extension was also loaded by the installed Pi `1.1.0` executable with
an isolated empty home/agent directory, no inherited credentials, no other
extensions or project resources, offline startup, and an in-memory session.
The explicit `/auto-perms` command exited successfully with no stderr.
This checks real extension-file loading and command registration, not
classifier quality or tool execution in the CLI.

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
