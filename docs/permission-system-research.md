# Permission-system research

## Problem and baseline

The user currently uses `@gotgenes/pi-permission-system` and wants fewer manual
approval decisions. The requested replacement for repetitive prompts is a fast,
probability-based review against plain-language rules and the user's task.

Inspection found Pi 1.1.0 and `@gotgenes/pi-permission-system` 40.1.4. The existing
policy allows file readers and many development tools, asks for writes, edits,
and unspecified tools, and protects selected environment-file patterns.

Some existing shell bypasses cover arbitrary `node`, `python`, `npm`, and `curl`
invocations. These are not intrinsically read-only or safe: interpreters can
execute arbitrary code, package scripts can have side effects, and HTTP clients
can send secrets. Do not copy these patterns into safe defaults merely because
they reduce prompts. The user's configuration has not been changed or copied
into this repository.

## Integration choices

### A. Add a reviewer to the existing permission system

Recommended starting point, pending the user's decision.

The installed permission system exposes
`getPermissionsService(sessionId).registerAuthorizer(name, authorize)`. A named
link is activated explicitly through its `authorizerChain` configuration. It
receives the complete permission-ask payload and can return `allow`, `deny`
with a reason, or `defer` to the existing manual/headless handling.

The permission system remains the enforcement owner:

1. It applies its deterministic policy to tool calls.
2. Effective deterministic `allow` and `deny` decisions bypass model review.
3. Requests resolving to `ask` enter the configured authorizer chain.
4. The reviewer applies the plain-language policy and threshold.
5. The enforcement owner either executes the tool or reports a denial.

This preserves existing command parsing, path handling, prompt forwarding, and
hard denials rather than reimplementing them. However, semantic rules on the
reviewer do not inspect calls the outer policy already allows. Its bypass policy
must therefore be deliberately narrow.

There is also an important delegation limit: the installed chain downgrades a
reviewer's `allow` to `defer` for `path` and `external_directory` surface families,
including read/write variants. A high model probability cannot override this.
An explicitly allowed directory can avoid a boundary prompt, but changing that
boundary policy must be a separate user decision.

### B. A standalone Pi permission extension

Use `pi.on("tool_call", ...)` directly and return `{ block: true, reason }` to
prevent execution. This offers control of the whole decision pipeline without a
permission-system dependency, but requires owning policy enforcement, file/path
safety, command parsing, project trust, confirmation behavior, and coexistence
with other permission handlers.

Running two independent gates does not let the new extension undo an old gate's
denial or prompt. A replacement would need an explicit installation transition;
this investigation has not disabled or uninstalled anything.

Pi's extension documentation says nested `ctx.executeTool()` calls pass through
the same tool hooks. This still needs a real runtime acceptance check. Tool
annotations are unverified hints, not permission grants. Arbitrary extension
code, child processes, and direct API calls are not necessarily tool calls; an
extension cannot provide an operating-system isolation boundary.

## Reviewer integration

Pi 1.1.0 already documents all requested models through
`ctx.modelRegistry.classify()`. Prefer this existing normalized interface over
three new HTTP clients, subject to verifying the actual extension/runtime seam.
Reviewer selection belongs in configuration, not implicit environment-variable
precedence. Existing Pi credentials can supply authentication separately.

- TypeSafe: `jev-latest`; System One state and named questions.
- Cloudflare Workers AI:
  `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`; System One at
  the Workers AI run endpoint.
- OpenAI: `gpt-6-luna`; `/v1/decisions` with input and a question array.

Pi normalizes boolean answers to a probability and choice answers to a choice,
probabilities, and confidence. Provider-specific probability and confidence
fields must not be treated as interchangeable. Scores need finite/range checks;
missing answers, refusals, cancellation, and `stopReason` errors cannot approve.

OpenAI Decisions requires an API key, not ChatGPT subscription authentication.
The installed Pi docs also warn that stored OpenAI OAuth credentials take
precedence over an environment API key. Credential setup must be explicit; this
project must not silently log the user out or alter their authentication.

Ask about permission and task authorization, not just whether an action appears
safe. A harmless action can still be unauthorized. A model probability does not
establish user consent for publication, spending, or destructive operations.

### Reasons without generated prose

These models return typed decisions rather than arbitrary written explanations.
A useful denial can still name a configured rule, selected reason category, or
failed threshold. Separate atomic questions can identify which policy condition
was violated. An outage message should describe a review failure, not claim the
model found the action unsafe. No extra text-generation model is necessary for
these basic reasons.

## Illustrative configuration

This is a proposal, not an implemented or approved schema. Possible locations:
`<agent-dir>/auto-perms.json` (normally `~/.pi/agent/auto-perms.json`) and
`<cwd>/.pi/auto-perms.json`.

```json
{
  "version": 1,
  "reviewer": {
    "provider": "typesafe",
    "model": "jev-latest"
  },
  "minAllowProbability": 0.95,
  "onUncertain": "ask",
  "onProviderError": "ask",
  "rules": [
    {
      "id": "task-scoped-development",
      "effect": "allow",
      "when": "Local development actions directly support the user's request."
    },
    {
      "id": "no-secret-exfiltration",
      "effect": "deny",
      "when": "The action sends secrets or credentials to an unapproved recipient."
    }
  ]
}
```

The threshold is a conservative starting proposal, not a measured calibration.
An interactive `ask` still requires approval before execution; without a usable
confirmation channel it must block. Deterministic denials remain immediate.

Recommended configuration boundaries, also pending approval:

- Reuse saved Pi credentials; do not put secrets in shared project policy.
- Keep reviewer endpoints, authentication, thresholds, and failure behavior under
  global/operator control. Project policy must not redirect credentials or
  silently lower the approval bar.
- Identify rules by stable IDs so additions and reviewed replacements are clear.
  Decide explicitly whether trusted projects may relax global rules or only
  tighten them. Do not silently use last-rule-wins for protected denials.
- Respect Pi's project-trust decision. Changes to an approved policy require
  renewed review; trust must not mean the agent may edit its own permissions.
- Send only necessary policy, task context, and tool evidence to the configured
  reviewer. Redaction or size limits that remove decision-relevant evidence must
  lead to escalation/blocking, not confident approval of a truncated request.
- Do not store raw tool inputs, file contents, or user conversation in an audit
  log by default. Record decision metadata and rule IDs instead.

## Reference project

The requested example is
[OpeOginni/oc-plugins: oc-auto-perms][oc-auto-perms]. Its README describes Jev
review of policy, recent user requests, and full tool input. Low confidence and
provider failures fall back to confirmation. It is a design reference, not a
Pi-compatible implementation or a security proof.

The README also documents a Code Mode bypass in its OpenCode integration. Do not
assume its tool coverage translates to Pi. The source inspected was at revision
`d845e988b87d782785ac02825e4e65c248380691`; npm reported version 0.1.3.

## Remaining decisions and checks

Before implementation, confirm the integration approach, uncertainty/error
handling, and the authority of project overrides. Before creating the public
remote, confirm the intended GitHub owner because the spoken account name and
the authenticated login differ.

No extension has been installed, no permission policy has been changed, and no
paid classifier API has been called. Documentation and source inspection establish
feasibility, not behavioral proof. Implementation needs deterministic provider
fixtures plus direct/nested tool-call tests in a real Pi session. Live provider
checks need credentials and a separately approved spending cap.

## Sources

- Installed Pi 1.1.0: `docs/extensions.md`, `docs/models.md`, `docs/codemode.md`,
  `docs/configuration.md`, `docs/security.md`, and `docs/packages.md`.
- Installed permission-system 40.1.4: `docs/configuration.md`,
  `docs/cross-extension-api.md`, and `dist/public.d.ts`.
- [Permission-system package documentation][permission-system].
- [TypeSafe Jev introduction and typed primitives][typesafe].
- [Cloudflare Clef launch and System One request example][clef].
- [OpenAI Decisions guide and request/response examples][openai-decisions].
- [oc-auto-perms README][oc-auto-perms].

[permission-system]: https://github.com/gotgenes/pi-packages/tree/pi-permission-system-v40.1.4/packages/pi-permission-system
[typesafe]: https://docs.typesafe.ai
[clef]: https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/
[openai-decisions]: https://developers.openai.com/api/docs/guides/decisions
[oc-auto-perms]: https://github.com/OpeOginni/oc-plugins/tree/d845e988b87d782785ac02825e4e65c248380691/packages/oc-auto-perms
