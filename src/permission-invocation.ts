import { createHash } from "node:crypto";

function sortedPermissionInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedPermissionInput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortedPermissionInput(item)]),
    );
  }
  return value;
}

/** Match exact tool arguments regardless of object-key order, without retaining their contents. */
export function permissionInvocationFingerprint(
  tool: string,
  input: Record<string, unknown>,
): string {
  const jsonInput: unknown = JSON.parse(JSON.stringify(input));
  return createHash("sha256")
    .update(tool)
    .update("\0")
    .update(JSON.stringify(sortedPermissionInput(jsonInput)))
    .digest("hex");
}
