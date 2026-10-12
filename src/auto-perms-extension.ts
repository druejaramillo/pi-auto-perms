import type { JsonObject } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { decideDeterministicPermission } from "./deterministic-permissions.ts";
import {
  loadPermissionConfig,
  type PermissionConfig,
  type PermissionMode,
} from "./permission-config.ts";
import { containsInlinePermissionCredentials } from "./permission-evidence.ts";
import { type PendingPermissionAction, reviewToolPermission } from "./permission-review.ts";

const permissionGuidance =
  "pi-auto-perms enforces tool permissions without dialogs. If a blocked result says to ask the user, ask a specific question in chat and wait for their answer. Do not immediately retry or switch tools to bypass a block. User approval is contextual, not a permanent permission grant. A deterministic deny requires an operator policy change, not merely a chat approval.";
const yoloPermissionGuidance =
  "pi-auto-perms YOLO mode is enabled: this extension bypasses all permission checks and model review. This does not override user instructions, other extensions, or operating-system permissions.";
const yoloModeWarning =
  "pi-auto-perms: YOLO enabled; all permission checks are bypassed and no reviewer is contacted. Use /auto-perms yolo off to restore review.";

interface PermissionConfigSnapshot {
  promise: Promise<PermissionConfig>;
  cwd: string;
  trusted: boolean;
}

/** Enforce non-interactive tool permissions unless the operator explicitly enables YOLO. */
export default function autoPermsExtension(pi: ExtensionAPI): void {
  let configSnapshot: PermissionConfigSnapshot | undefined;
  let userMessages: string[] = [];
  let userRevision = 0;
  let waitingAtRevision: number | undefined;
  let pending: PendingPermissionAction | undefined;
  let sessionMode: PermissionMode | undefined;

  pi.registerFlag("auto-perms-yolo", {
    description: "Bypass all pi-auto-perms checks without contacting a reviewer",
    type: "boolean",
    default: false,
  });

  function updatePermissionModeStatus(ctx: ExtensionContext, mode: PermissionMode | undefined) {
    ctx.ui.setStatus(
      "auto-perms",
      mode === "yolo"
        ? "YOLO: permissions disabled"
        : mode === "review"
          ? "permissions: review"
          : "permissions: configuration error",
    );
  }

  function recordYoloAllowance(event: ToolCallEvent): void {
    pi.appendEntry("auto-perms-decision", {
      tool: event.toolName,
      toolCallId: event.toolCallId,
      action: "allow",
      source: "yolo",
    });
  }

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
    sessionMode = pi.getFlag("auto-perms-yolo") === true ? "yolo" : undefined;
    const snapshot = reloadConfigSnapshot(ctx);
    // Finish loading the snapshot before startup continues, retaining rejection for tool_call.
    const policy = await snapshot.promise.catch(() => undefined);
    const mode = sessionMode ?? policy?.mode;
    updatePermissionModeStatus(ctx, mode);
    if (mode === "yolo") ctx.ui.notify(yoloModeWarning, "warning");
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      userMessages = [...userMessages, event.text].slice(-20);
      userRevision += 1;
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const policy =
      sessionMode === undefined
        ? await currentConfigSnapshot(ctx).promise.catch(() => undefined)
        : undefined;
    const mode = sessionMode ?? policy?.mode;
    updatePermissionModeStatus(ctx, mode);
    const guidance = mode === "yolo" ? yoloPermissionGuidance : permissionGuidance;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });
  pi.registerCommand("auto-perms", {
    description: "Show permissions, reload policy, or set session YOLO with yolo on|off",
    handler: async (args, ctx) => {
      const command = args.trim().replace(/\s+/g, " ");
      if (command === "yolo on" || command === "yolo off") {
        sessionMode = command === "yolo on" ? "yolo" : "review";
        // Keep an old review stale even if the operator switches on and then back off.
        userRevision += 1;
        waitingAtRevision = undefined;
        pending = undefined;
        updatePermissionModeStatus(ctx, sessionMode);
        ctx.ui.notify(
          sessionMode === "yolo"
            ? yoloModeWarning
            : "pi-auto-perms: YOLO disabled; permission gates and model review restored for this session.",
          sessionMode === "yolo" ? "warning" : "info",
        );
        return;
      }
      if (command !== "" && command !== "reload") {
        ctx.ui.notify("Usage: /auto-perms [reload | yolo on | yolo off]", "warning");
        return;
      }
      if (command === "reload") reloadConfigSnapshot(ctx);
      if (sessionMode === "yolo") {
        updatePermissionModeStatus(ctx, "yolo");
        ctx.ui.notify(yoloModeWarning, "warning");
        return;
      }
      try {
        const policy = await currentConfigSnapshot(ctx).promise;
        const mode = sessionMode ?? policy.mode;
        updatePermissionModeStatus(ctx, mode);
        ctx.ui.notify(
          mode === "yolo"
            ? yoloModeWarning
            : `pi-auto-perms: review; ${policy.reviewer.provider}/${policy.reviewer.model}; approval >= ${policy.minAllowProbability}; ${policy.rules.length} rules; project overrides ${ctx.isProjectTrusted() ? "enabled" : "skipped (untrusted)"}.`,
          mode === "yolo" ? "warning" : "info",
        );
      } catch {
        updatePermissionModeStatus(ctx, undefined);
        ctx.ui.notify(
          "pi-auto-perms: Invalid configuration; tool calls are blocked. Check auto-perms.json and reload.",
          "error",
        );
      }
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (sessionMode === "yolo" && !ctx.signal?.aborted) return recordYoloAllowance(event);
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
          "pi-auto-perms: Policy, permission mode, user context, or tool arguments changed during evaluation. No stale permission was applied. Ask the user for clarification before retrying.",
      };
      if (stale()) return staleBlock;
      if ((sessionMode ?? policy.mode) === "yolo") return recordYoloAllowance(event);
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
