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
import { permissionInvocationFingerprint } from "./permission-invocation.ts";
import { type PendingPermissionAction, reviewToolPermission } from "./permission-review.ts";

const permissionGuidance =
  "pi-auto-perms enforces tool permissions without dialogs. If a blocked result says to ask the user, ask a specific question in chat and wait for their answer. Do not immediately retry or switch tools to bypass a block. User approval is contextual, not a permanent permission grant. A deterministic deny requires an operator policy change, not merely a chat approval. Written approval is reviewed with the user's reply and your preceding question; do not replace that normal flow with a command. If the reviewer still refuses, explain the remaining risk or uncertainty and tell the user they can use /auto-perms approve to override the last reviewer-blocked invocation once. Only the user should initiate that override.";
const yoloPermissionGuidance =
  "pi-auto-perms YOLO mode is enabled: this extension bypasses all permission checks and model review. This does not override user instructions, other extensions, or operating-system permissions.";
const yoloModeWarning =
  "pi-auto-perms: YOLO enabled; all permission checks are bypassed and no reviewer is contacted. Use /auto-perms yolo off to restore review.";

interface PermissionConfigSnapshot {
  promise: Promise<PermissionConfig>;
  cwd: string;
  trusted: boolean;
}

type PermissionManualApproval = {
  tool: string;
  inputFingerprint: string;
  branchEntryId: string | null;
  snapshot: PermissionConfigSnapshot;
} & ({ state: "blocked" } | { state: "approved"; revision: number });

/** Enforce non-interactive tool permissions unless the operator explicitly enables YOLO. */
export default function autoPermsExtension(pi: ExtensionAPI): void {
  let configSnapshot: PermissionConfigSnapshot | undefined;
  let userMessages: string[] = [];
  let assistantMessageBeforeLatestUser: string | undefined;
  let userRevision = 0;
  let waitingAtRevision: number | undefined;
  let pending: PendingPermissionAction | undefined;
  let sessionMode: PermissionMode | undefined;
  let manualApproval: PermissionManualApproval | undefined;

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
    manualApproval = undefined;
    return configSnapshot;
  }

  function currentConfigSnapshot(ctx: ExtensionContext): PermissionConfigSnapshot {
    return configSnapshot?.cwd === ctx.cwd && configSnapshot.trusted === ctx.isProjectTrusted()
      ? configSnapshot
      : reloadConfigSnapshot(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    userMessages = [];
    assistantMessageBeforeLatestUser = undefined;
    userRevision += 1;
    sessionMode = pi.getFlag("auto-perms-yolo") === true ? "yolo" : undefined;
    const snapshot = reloadConfigSnapshot(ctx);
    // Finish loading the snapshot before startup continues, retaining rejection for tool_call.
    const policy = await snapshot.promise.catch(() => undefined);
    const mode = sessionMode ?? policy?.mode;
    updatePermissionModeStatus(ctx, mode);
    if (mode === "yolo") ctx.ui.notify(yoloModeWarning, "warning");
  });
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") {
      manualApproval = undefined;
      const previousAssistant = ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      assistantMessageBeforeLatestUser =
        previousAssistant?.type === "message" && previousAssistant.message.role === "assistant"
          ? previousAssistant.message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n") || undefined
          : undefined;
      userMessages = [...userMessages, event.text].slice(-20);
      userRevision += 1;
    }
  });
  pi.on("agent_settled", () => {
    if (manualApproval?.state === "approved") manualApproval = undefined;
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
    description: "Show permissions, approve one blocked review, reload, or set yolo on|off",
    handler: async (args, ctx) => {
      const command = args.trim().replace(/\s+/g, " ");
      if (command === "approve") {
        const snapshot = currentConfigSnapshot(ctx);
        const target = manualApproval;
        const revision = userRevision;
        if (!ctx.isIdle() || target?.state !== "blocked") {
          ctx.ui.notify(
            "pi-auto-perms: No idle reviewer-blocked action is available to approve. Deterministic denials require a policy change, not /auto-perms approve.",
            "warning",
          );
          return;
        }
        const policy = await snapshot.promise.catch(() => undefined);
        if (
          !policy ||
          !ctx.isIdle() ||
          manualApproval !== target ||
          target.snapshot !== snapshot ||
          configSnapshot !== snapshot ||
          revision !== userRevision ||
          ctx.cwd !== snapshot.cwd ||
          ctx.isProjectTrusted() !== snapshot.trusted ||
          !ctx.sessionManager.getBranch().some((entry) => entry.id === target.branchEntryId)
        ) {
          manualApproval = undefined;
          ctx.ui.notify(
            "pi-auto-perms: The blocked action's policy or context changed; no override was granted.",
            "warning",
          );
          return;
        }
        userRevision += 1;
        manualApproval = { ...target, state: "approved", revision: userRevision };
        waitingAtRevision = undefined;
        pending = undefined;
        ctx.ui.notify(
          `pi-auto-perms: Reviewer override granted once for ${target.tool}, with identical arguments. Deterministic denials still apply. Retrying through the agent.`,
          "warning",
        );
        pi.sendUserMessage(
          `The operator used /auto-perms approve to override the last reviewer-blocked ${JSON.stringify(target.tool)} invocation once. Retry only that exact invocation with unchanged arguments if still needed. This is not permission for other actions.`,
          { deliverAs: "followUp" },
        );
        return;
      }
      if (command === "yolo on" || command === "yolo off") {
        sessionMode = command === "yolo on" ? "yolo" : "review";
        // Keep an old review stale even if the operator switches on and then back off.
        userRevision += 1;
        waitingAtRevision = undefined;
        pending = undefined;
        manualApproval = undefined;
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
        ctx.ui.notify("Usage: /auto-perms [approve | reload | yolo on | yolo off]", "warning");
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
        manualApproval = undefined;
        pending = undefined;
        return {
          block: true,
          reason: `pi-auto-perms: Denied by deterministic rule '${deterministic.rule}'. Do not bypass this block. Chat approval cannot override this rule; ask the user to change the global/project policy if appropriate.`,
        };
      }
      if (manualApproval?.state === "approved") {
        const approval = manualApproval;
        // The next reviewed invocation consumes the override, including a mismatched retry.
        manualApproval = undefined;
        if (
          approval.snapshot === snapshot &&
          approval.revision === revision &&
          ctx.sessionManager.getBranch().some((entry) => entry.id === approval.branchEntryId) &&
          approval.inputFingerprint === permissionInvocationFingerprint(event.toolName, event.input)
        ) {
          pending = undefined;
          waitingAtRevision = undefined;
          pi.appendEntry("auto-perms-decision", {
            tool: event.toolName,
            toolCallId: event.toolCallId,
            action: "allow",
            source: "manual-approval",
          });
          return;
        }
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
        assistantMessageBeforeLatestUser,
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
      manualApproval = {
        state: "blocked",
        tool: event.toolName,
        inputFingerprint: permissionInvocationFingerprint(event.toolName, event.input),
        branchEntryId: ctx.sessionManager.getLeafId(),
        snapshot,
      };
      waitingAtRevision = review.action === "ask" ? revision : undefined;
      const pendingInput: JsonObject = JSON.parse(inputSnapshot);
      pending =
        inputSnapshot.length <= Math.min(8192, policy.maxReviewChars / 4) &&
        !containsInlinePermissionCredentials(pendingInput)
          ? { tool: event.toolName, input: pendingInput }
          : undefined;
      return { block: true, reason: review.reason };
    } catch {
      manualApproval = undefined;
      pending = undefined;
      return {
        block: true,
        reason:
          "pi-auto-perms: Configuration or deterministic evaluation failed; no tool was executed. Ask the user to fix the policy and run /auto-perms reload. Do not bypass the block.",
      };
    }
  });
}
