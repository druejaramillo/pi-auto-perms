import type { JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const recentActivityLimit = 12;

type PermissionTaskActivity = JsonObject & {
  kind: "assistant" | "tool";
  entryId: string;
};

/** Collect bounded task context from the active projection, never thinking or user consent. */
export function collectPermissionTaskContext(
  sessionManager: Pick<ExtensionContext["sessionManager"], "buildSessionProjection">,
  maxChars: number,
): JsonObject | undefined {
  if (maxChars <= 0) return;
  const entries = sessionManager.buildSessionProjection().entries;
  const latestUserIndex = entries.findLastIndex(
    (entry) =>
      entry.sourceEntry.type === "message" &&
      entry.messages.some((message) => message.role === "user"),
  );
  const calls = new Map<string, { name: string; input: JsonObject }>();
  const activities: PermissionTaskActivity[] = [];
  for (const [index, entry] of entries.entries()) {
    // Custom messages and summaries can be rendered as user text, but are not task authority.
    if (entry.sourceEntry.type !== "message") continue;
    const provenance = {
      entryId: entry.sourceEntry.id,
      afterLatestUserMessage: index > latestUserIndex,
    };
    for (const message of entry.messages) {
      if (message.role === "assistant") {
        const text = message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n");
        if (text) activities.push({ kind: "assistant", ...provenance, text });
        for (const block of message.content) {
          if (block.type === "toolCall")
            calls.set(block.id, {
              name: block.name,
              input: JSON.parse(JSON.stringify(block.arguments)),
            });
        }
      } else if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId);
        calls.delete(message.toolCallId);
        activities.push({
          kind: "tool",
          ...provenance,
          toolName: message.toolName,
          input: call?.name === message.toolName ? call.input : null,
          output: message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n"),
          hasNonTextContent: message.content.some((block) => block.type !== "text"),
          isError: message.isError,
        });
      }
    }
  }

  const recentActivity: JsonObject[] = [];
  let omittedActivityCount = activities.length;
  const context = () => ({ recentActivity, omittedActivityCount });
  if (JSON.stringify(context()).length > maxChars) return;
  // Prefer the newest whole observations; never clip a script and present it as complete.
  for (const activity of activities.slice(-recentActivityLimit).reverse()) {
    const fits = (candidate: JsonObject, omitted: number) =>
      JSON.stringify({
        recentActivity: [candidate, ...recentActivity],
        omittedActivityCount: omitted,
      }).length <= maxChars;
    if (fits(activity, omittedActivityCount - 1)) {
      recentActivity.unshift(activity);
      omittedActivityCount -= 1;
    } else {
      const omitted: JsonObject = {
        kind: "omitted",
        entryId: activity.entryId,
        sourceKind: activity.kind,
        ...(activity.kind === "tool" ? { toolName: activity.toolName } : {}),
        reason: "context size limit",
      };
      if (fits(omitted, omittedActivityCount)) recentActivity.unshift(omitted);
    }
  }
  return context();
}
