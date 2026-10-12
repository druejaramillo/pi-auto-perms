import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-ai";
import { loadPermissionConfig, type PermissionConfig } from "./permission-config.ts";
import { decideDeterministicPermission } from "./deterministic-permissions.ts";
import { reviewToolPermission, type PendingPermissionAction } from "./permission-review.ts";

const permissionGuidance = "pi-auto-perms enforces tool permissions without dialogs. If a blocked result says to ask the user, ask a specific question in chat and wait for their answer. Do not immediately retry or switch tools to bypass a block. User approval is contextual, not a permanent permission grant. A deterministic deny requires an operator policy change, not merely a chat approval.";

/** Enforce non-interactive tool permissions in each Pi session. */
export default function autoPermsExtension(pi: ExtensionAPI): void {
  let config: Promise<PermissionConfig> | undefined;
  let userMessages: string[] = [];
  let pending: PendingPermissionAction | undefined;

  pi.on("session_start", (_event, ctx) => {
    userMessages = [];
    pending = undefined;
    config = loadPermissionConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
    // Retain rejection for tool_call without an unhandled startup promise.
    void config.catch(() => {});
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") userMessages = [...userMessages, event.text].slice(-20);
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${permissionGuidance}`,
  }));
  pi.registerCommand("auto-perms", {
    description: "Show the reviewer configuration, or reload policy with /auto-perms reload",
    handler: async (args, ctx) => {
      if (args.trim() === "reload") config = loadPermissionConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      try {
        config ??= loadPermissionConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
        const policy = await config;
        ctx.ui.notify(`pi-auto-perms: ${policy.reviewer.provider}/${policy.reviewer.model}; approval >= ${policy.minAllowProbability}; ${policy.rules.length} rules; project overrides ${ctx.isProjectTrusted() ? "enabled" : "skipped (untrusted)"}.`, "info");
      } catch {
        ctx.ui.notify("pi-auto-perms: Invalid configuration; tool calls are blocked. Check auto-perms.json and reload.", "error");
      }
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      config ??= loadPermissionConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      const policy = await config;
      const deterministic = await decideDeterministicPermission(policy, event.toolName, event.input, ctx.cwd);
      if (deterministic.action !== "ask") {
        pi.appendEntry("auto-perms-decision", { tool: event.toolName, toolCallId: event.toolCallId, action: deterministic.action, source: "deterministic", rule: deterministic.rule });
        if (deterministic.action === "allow") return;
        return { block: true, reason: `pi-auto-perms: Denied by deterministic rule '${deterministic.rule}'. Do not bypass this block. Chat approval cannot override this rule; ask the user to change the global/project policy if appropriate.` };
      }
      const review = await reviewToolPermission(policy, event.toolName, event.input, ctx, userMessages, pending);
      pi.appendEntry("auto-perms-decision", { tool: event.toolName, toolCallId: event.toolCallId, action: review.action, source: "reviewer", ...(review.probability === undefined ? {} : { probability: review.probability }) });
      if (review.action === "allow") {
        pending = undefined;
        return;
      }
      pending = { tool: event.toolName, input: JSON.parse(JSON.stringify(event.input)) as JsonObject };
      return { block: true, reason: review.reason };
    } catch {
      return { block: true, reason: "pi-auto-perms: Configuration or deterministic evaluation failed; no tool was executed. Ask the user to fix the policy and run /auto-perms reload. Do not bypass the block." };
    }
  });
}
