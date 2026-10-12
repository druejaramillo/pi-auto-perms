import type { JsonObject } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { decideDeterministicPermission } from "./deterministic-permissions.ts";
import { loadPermissionConfig, type PermissionConfig } from "./permission-config.ts";
import { containsInlinePermissionCredentials } from "./permission-evidence.ts";
import { type PendingPermissionAction, reviewToolPermission } from "./permission-review.ts";

const permissionGuidance =
  "pi-auto-perms enforces tool permissions without dialogs. If a blocked result says to ask the user, ask a specific question in chat and wait for their answer. Do not immediately retry or switch tools to bypass a block. User approval is contextual, not a permanent permission grant. A deterministic deny requires an operator policy change, not merely a chat approval.";

interface PermissionConfigSnapshot {
  promise: Promise<PermissionConfig>;
  cwd: string;
  trusted: boolean;
}

/** Enforce non-interactive tool permissions in each Pi session. */
export default function autoPermsExtension(pi: ExtensionAPI): void {
  let configSnapshot: PermissionConfigSnapshot | undefined;
  let userMessages: string[] = [];
  let userRevision = 0;
  let waitingAtRevision: number | undefined;
  let pending: PendingPermissionAction | undefined;

  function reloadConfigSnapshot(ctx: ExtensionContext): PermissionConfigSnapshot {
    const trusted = ctx.isProjectTrusted();
    configSnapshot = {
      cwd: ctx.cwd,
      trusted,
      promise: loadPermissionConfig(getAgentDir(), ctx.cwd, trusted),
    };
    waitingAtRevision = undefined;
    pending = undefined;
    return configSnapshot;
  }

  function currentConfigSnapshot(ctx: ExtensionContext): PermissionConfigSnapshot {
    return configSnapshot?.cwd === ctx.cwd && configSnapshot.trusted === ctx.isProjectTrusted()
      ? configSnapshot
      : reloadConfigSnapshot(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    userMessages = [];
    userRevision += 1;
    const snapshot = reloadConfigSnapshot(ctx);
    // Finish loading the snapshot before startup continues, retaining rejection for tool_call.
    await snapshot.promise.catch(() => {});
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      userMessages = [...userMessages, event.text].slice(-20);
      userRevision += 1;
    }
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${permissionGuidance}`,
  }));
  pi.registerCommand("auto-perms", {
    description: "Show the reviewer configuration, or reload policy with /auto-perms reload",
    handler: async (args, ctx) => {
      if (args.trim() === "reload") reloadConfigSnapshot(ctx);
      try {
        const policy = await currentConfigSnapshot(ctx).promise;
        ctx.ui.notify(
          `pi-auto-perms: ${policy.reviewer.provider}/${policy.reviewer.model}; approval >= ${policy.minAllowProbability}; ${policy.rules.length} rules; project overrides ${ctx.isProjectTrusted() ? "enabled" : "skipped (untrusted)"}.`,
          "info",
        );
      } catch {
        ctx.ui.notify(
          "pi-auto-perms: Invalid configuration; tool calls are blocked. Check auto-perms.json and reload.",
          "error",
        );
      }
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      const snapshot = currentConfigSnapshot(ctx);
      const revision = userRevision;
      const inputSnapshot = JSON.stringify(event.input);
      const policy = await snapshot.promise;
      const stale = () =>
        configSnapshot !== snapshot ||
        userRevision !== revision ||
        ctx.signal?.aborted ||
        ctx.cwd !== snapshot.cwd ||
        ctx.isProjectTrusted() !== snapshot.trusted ||
        JSON.stringify(event.input) !== inputSnapshot;
      const staleBlock = {
        block: true,
        reason:
          "pi-auto-perms: Policy, user context, or tool arguments changed during evaluation. No stale permission was applied. Ask the user for clarification before retrying.",
      };
      const deterministic = await decideDeterministicPermission(
        policy,
        event.toolName,
        event.input,
        ctx.cwd,
      );
      if (stale()) return staleBlock;
      if (deterministic.action !== "ask") {
        pi.appendEntry("auto-perms-decision", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          action: deterministic.action,
          source: "deterministic",
          rule: deterministic.rule,
        });
        if (deterministic.action === "allow") return;
        return {
          block: true,
          reason: `pi-auto-perms: Denied by deterministic rule '${deterministic.rule}'. Do not bypass this block. Chat approval cannot override this rule; ask the user to change the global/project policy if appropriate.`,
        };
      }
      const waitingBlock = {
        block: true,
        reason:
          "pi-auto-perms: Awaiting a new user reply after a blocked action. Do not retry or switch tools to bypass it. Ask the user explicitly in chat and wait for their answer.",
      };
      if (waitingAtRevision === revision) return waitingBlock;
      const description = pi
        .getAllTools()
        .find((tool) => tool.name === event.toolName)?.description;
      const review = await reviewToolPermission(
        policy,
        event.toolName,
        event.input,
        ctx,
        userMessages,
        pending,
        description,
      );
      if (stale()) return staleBlock;
      // A sibling call may have requested user clarification while this one was reviewing.
      if (waitingAtRevision === revision) return waitingBlock;
      pi.appendEntry("auto-perms-decision", {
        tool: event.toolName,
        toolCallId: event.toolCallId,
        action: review.action,
        source: "reviewer",
        ...(review.probability === undefined ? {} : { probability: review.probability }),
      });
      if (review.action === "allow") {
        pending = undefined;
        return;
      }
      waitingAtRevision = review.action === "ask" ? revision : undefined;
      const pendingInput: JsonObject = JSON.parse(inputSnapshot);
      pending =
        inputSnapshot.length <= Math.min(8192, policy.maxReviewChars / 4) &&
        !containsInlinePermissionCredentials(pendingInput)
          ? { tool: event.toolName, input: pendingInput }
          : undefined;
      return { block: true, reason: review.reason };
    } catch {
      return {
        block: true,
        reason:
          "pi-auto-perms: Configuration or deterministic evaluation failed; no tool was executed. Ask the user to fix the policy and run /auto-perms reload. Do not bypass the block.",
      };
    }
  });
}
