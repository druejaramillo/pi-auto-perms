# Configuration

## Files and loading

Global settings are read from `<getAgentDir()>/auto-perms.json`. Pi normally
uses `~/.pi/agent`; `PI_CODING_AGENT_DIR` can select another agent directory.
Project policy is read from `<cwd>/.pi/auto-perms.json` only when
`ctx.isProjectTrusted()` is true. Untrusted project policy is not read.

Files are strict JSON. Missing files use inherited defaults. Invalid JSON,
unknown top-level fields, invalid values, and duplicate rule IDs block tool
calls rather than silently falling back to a more permissive configuration.
An explicit session/CLI YOLO override can bypass even a broken policy; global
`"mode": "yolo"` still requires valid applicable configuration files.
Do not copy the old permission extension's entire configuration verbatim.

Policy is snapshotted at session startup. Editing a file does not silently
change running permissions: use `/auto-perms reload`. Changes to the working
directory or native project-trust state also refresh the applicable snapshot.
A reload clears pending-action evidence, manual override state, and the wait
for a chat reply; it invalidates any review using the previous snapshot.

## Global settings

The complete example is [global-auto-perms.json](../examples/global-auto-perms.json).
All fields are optional; `version`, when present, must be `1`.

| Setting | Default | Accepted values |
| --- | --- | --- |
| `mode` | `"review"` | `"review"` or `"yolo"`; global only |
| `reviewer` | TypeSafe Jev | Explicit provider/model pair |
| `minAllowProbability` | `0.95` | Greater than `0.5`, at most `1` |
| `reviewTimeoutMs` | `5000` | Integer milliseconds, `1`–`120000` |
| `historyLimit` | `3` | Integer recent user messages, `1`–`20` |
| `maxReviewChars` | `32000` | Serialized review characters, `1024`–`128000` |
| `permission` | Built-in deterministic policy | Surface policies below |
| `rules` | Built-in semantic rules | At most 100 unique rules per file |

The threshold uses the probability of the selected **allow choice**, not a
separate confidence field. The default is a starting point, not a calibrated
claim about real-world correctness. Reviews require a valid normalized
distribution and a non-conflicting reason category.

There is no `failOpen`, dialog fallback, or alternate-provider fallback.
Provider errors and timeouts block the action. A user saying “yes” does not
repair missing credentials, an invalid policy, or an oversized review.
These fail-closed rules apply in review mode; YOLO is an explicit operator
bypass, not a fallback after a failed review.

## YOLO mode

Enable only when you intend to bypass **all** pi-auto-perms checks:

- `/auto-perms yolo on`: enable YOLO for the current session.
- `/auto-perms yolo off`: force review mode for the current session, even
  when the global configuration or CLI flag enabled YOLO.
- `pi --auto-perms-yolo`: start with a YOLO override; no reviewer credentials
  are required. The extension must still be loaded.
- Global `auto-perms.json`: `{ "mode": "yolo" }` selects a persistent default.
  Use `{ "mode": "review" }`, or omit `mode`, for normal enforcement.

Session commands do not write files. They take precedence over the global/CLI
default and survive `/auto-perms reload`. A new session or extension reload
clears the session command override and reapplies the global/CLI default.
Mode changes clear pending-action/wait and manual override state and invalidate in-flight reviews,
even when switched on and then back off. Already executing tools are not undone.

YOLO skips tool/path/directory/shell denials, semantic review, inline-credential
and evidence-size guards, and waiting for chat approval. No arguments are sent
to a permission reviewer. Decision entries identify `source: "yolo"` without
storing arguments. `/auto-perms` and Pi's status area identify the active mode;
startup and enable commands warn when YOLO is active. No dialogs are opened.

Project JSON cannot set `mode`. A trusted project containing this unsupported
field is invalid; untrusted project files remain ignored. Ordinary prompt text
does not toggle modes. Other extensions can still block actions or show dialogs,
and normal tool validation, availability, cancellation, OS permissions, and
user instructions still apply.

## Reviewer and credentials

Select one pair explicitly:

```json
{ "reviewer": { "provider": "typesafe", "model": "jev-latest" } }
```

```json
{
  "reviewer": {
    "provider": "cloudflare-workers-ai",
    "model": "@cf/cloudflare/clef-flash"
  }
}
```

```json
{ "reviewer": { "provider": "openai", "model": "gpt-6-luna" } }
```

Use Pi's `/login <provider>` flow or existing stored API-key credentials.
For headless environments Pi also supports:

- TypeSafe: `TYPESAFE_API_KEY`.
- Cloudflare Workers AI: `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`.
- OpenAI: `OPENAI_API_KEY`, with API access to the Decisions model.

The Cloudflare account ID can instead be stored in the credential's `env`
object in Pi's private `auth.json`. Preserve existing entries when editing
that file; do not overwrite or commit it.

OpenAI Decisions does not accept ChatGPT subscription OAuth as an API-key
substitute. Stored OAuth can take precedence over an environment key;
check the selected provider's credential method rather than assuming that
setting `OPENAI_API_KEY` replaces it.

The extension delegates credential resolution to Pi. It does not inspect
credential files to choose a provider, copy secrets into review state, or
manage authentication. `/auto-perms` displays selection and policy metadata;
it does not call a paid provider to test connectivity.

## Deterministic surface policies

A surface can be an action or an ordered glob map:

```json
{
  "permission": {
    "write": "ask",
    "bash": {
      "*": "ask",
      "git status --short": "allow",
      "rm -rf *": "deny"
    },
    "path_read": {
      "*/private/*": "deny"
    }
  }
}
```

Actions are `allow`, `deny`, and `ask`. `ask` invokes the decision model,
never a permission dialog. A deterministic `deny` cannot be overridden by
chat approval or `/auto-perms approve`: an operator must change the applicable
global/project policy.

- `*` is the fallback tool policy. Exact tool names select their own surface.
- `read`, `write`, `edit`, `grep`, `find`, and `ls` maps match file paths.
- `path` supplies both `path_read` and `path_write` policy.
- `external_directory` supplies both directional external-directory policies.
- A directional surface refines its bare family within a configuration file.
- `code_format` and `code_ast` maps select `preview` or `apply`. File-path
  protection is checked separately; preview allowance is not write allowance.
- `bash` maps match literal and parsed commands. A denied command anywhere
  in a shell chain stays denied. Operators, expansion, redirection, or
  ambiguity keep broad allow globs from granting an entire complex script;
  those actions go to review.
- Other tools default to review unless explicitly allowed. Top-level `path`
  or `paths` arguments also receive path and boundary checks; unknown tools
  with paths are checked in both directions.

Globs support `*` and `?`; `~` expands to the current home directory. Last
matching pattern wins. Do not sort permission-map keys: order is behavior.
Paths are checked in requested, resolved, and canonical forms, including
symlinks and Pi 1.1's `read` filename fallbacks. Native file-tool paths also
normalize Pi's leading `@` syntax. Across applicable gates, any denial wins;
otherwise any `ask` requires review.

Built-in fast paths allow routine file inspection, common skills/reference
reads, `code_lsp`, `code_check`, formatter/AST previews, and a few literal
Git inspection commands. Ordinary writes, applied transformations, unknown
tools, and general shell commands require review. Default path protections
cover environment files, SSH material, `auth.json`, and `.key` files, with
an environment-example exception. These are not exhaustive secret detection.
The source of defaults is [permission-config.ts](../src/permission-config.ts).

## Plain-language rules

```json
{
  "rules": [
    {
      "id": "no-production",
      "effect": "deny",
      "when": "The action changes a production service."
    },
    {
      "id": "project-development",
      "effect": "allow",
      "when": "The action is local development needed for the user's task."
    }
  ]
}
```

IDs start with a letter and contain at most 64 letters, digits, `.`, `_`,
or `-`. IDs must be unique within each file. `when` is a nonempty natural-
language condition, not executable code. Applicable denial rules take
precedence over allowances in the review criteria.

A rule without an authorization exception remains a denial after chat
approval. Write the condition you intend: “deploys to production” and
“deploys to production without explicit user authorization” are different
policies. Unclear applicability should produce `ask`, not an inferred grant.

Built-in IDs are `routine-development`, `explicit-authorization`, and
`private-data`. The defaults allow scoped local development and deny
unauthorized publication, spending, irreversible changes, policy/credential
changes, private-data exposure, and disregard of the latest user refusal.
Deterministic allowances run first and bypass these semantic rules.

## Project override authority

Project files accept `version`, `permission`, and `rules`, not permission mode,
reviewer selection, or runtime limits. Once the project is trusted:

1. A semantic rule with an inherited ID replaces that rule completely.
   Other inherited IDs remain; new IDs add rules.
2. A scalar surface replaces the inherited surface completely.
3. Two pattern maps retain unmatched inherited patterns, remove matching
   inherited keys, then append all project patterns. Last-match precedence
   applies to the resulting order. A project `"*": "allow"` can therefore
   override a global protected-path denial. A catch-all can overshadow
   inherited patterns even when its own value is unchanged.
4. Bare path/boundary families expand into both directions before scopes
   merge, so a project bare family can override global directional policy.

There are no locked global denials. This is full policy authority, not an
untrusted-repository containment mechanism. See
[project-auto-perms.json](../examples/project-auto-perms.json) for an example
that relaxes a global shell denial and adds a scoped semantic allowance.

## Conversation and failure handling

Written approval is the usual flow. The reviewer receives recent genuine
interactive/RPC user messages in order, the assistant message preceding the
latest reply, and an indicator of whether the invocation exactly matches the
previous blocked action. It does not receive the full transcript or treat
extension-generated user messages as consent. The most recent refusal wins.

A short “yes” to the agent's question authorizes that question's action and
scope. A reply to a different question does not authorize an older block.
An explicit encompassing grant, such as “you can use all Git commands,” can
supply consent for `git --version`; the reviewer evaluates that command's
actual effects rather than hypothetical dangerous Git operations. Narrow
approval is not expanded into a broad or permanent grant.

Deterministic `ask` entries mean “send to review,” not “consent is missing.”
The reviewer is instructed to allow a clearly authorized routine invocation
with no applicable denial or unresolved serious risk. Approval can satisfy a
rule's authorization exception; unconditional semantic denials and genuine
uncertainty about harm, recipients, or effects remain relevant. The threshold
is unchanged, and the extension never invents an allow score from written
consent. Live reviewer recognition of these instructions is not yet verified.

Only one bounded pending action is retained. Credential-bearing or large
arguments are not kept as pending evidence. If a short reply is ambiguous,
the agent should ask for a specific restatement of the authorization.

An uncertain review pauses further reviewed calls until a new genuine user
message or operator reload. A clear denial still permits independently
allowed alternatives; it does not authorize switching tools to perform the
same forbidden action. Every new reviewed action gets a fresh decision.
Reviewer approvals are not cached across calls or sessions.

The complete serialized review must fit `maxReviewChars`; evidence is never
truncated to obtain approval. Obvious inline credentials block submission
rather than being silently redacted from the action. Provider exceptions
are reported generically instead of echoing potentially sensitive details.
The selected reviewer sees full tool arguments, including proposed file
contents and the assistant's preceding message, so choose it with your code
and data policies in mind.

## One-use reviewer override

If the reviewer still refuses after normal chat approval, the user can enter:

```text
/auto-perms approve
```

This is an explicit operator override, not another classifier request:

- It targets the last reviewer-blocked invocation in the current conversation
  branch. The agent must be idle; the command resumes it with instructions to
  retry only that invocation. It never invokes the tool directly.
- It deliberately skips semantic review, including semantic denials,
  uncertainty, provider/timeout failures, and credential/evidence guards.
  It cannot repair invalid configuration or bypass tool/path/directory/shell
  denials. Change policy explicitly for a deterministic denial.
- The tool and complete arguments must match. Object-key ordering is ignored;
  changed values, array order, path spelling, or tool name are not. A bounded
  fingerprint is stored, not another copy of potentially sensitive arguments.
- The next review-routed invocation consumes the override. A mismatch revokes
  it and goes through normal review. Deterministic inspection can still run
  without consuming it; the grant expires when the retry turn settles unused.
- New genuine user input, policy reloads, cwd/trust changes, mode changes,
  session/extension reloads, or leaving the target's branch invalidate it.
  A newer deterministic denial also clears an older override target.
- Decision metadata records `source: "manual-approval"` without arguments.
  Other extensions, tool validation, cancellation, OS permissions, and user
  instructions still apply.

The extension-generated retry message is not treated as chat consent for any
other action. The agent should not initiate this command or turn it into the
normal permission flow. No files, authentication, threshold, or permanent
policy settings are changed.
