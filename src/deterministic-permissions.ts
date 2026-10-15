import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "shell-quote";
import type { PermissionAction, PermissionConfig } from "./permission-config.ts";
import { stripPermissionShellHeredocs } from "./permission-shell-heredocs.ts";

/** A deterministic decision, retaining the rule that decided it. */
export interface DeterministicDecision {
  action: PermissionAction;
  rule: string;
}

const rank: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };
const readers = new Set(["read", "grep", "find", "ls", "code_check", "code_lsp"]);
const nativePathTools = new Set(["read", "write", "edit", "grep", "find", "ls"]);

/** A shell parsing failure that never includes potentially sensitive command text. */
export class PermissionShellParseError extends Error {
  constructor() {
    super("pi-auto-perms: Shell command parsing failed during deterministic evaluation.");
    this.name = "PermissionShellParseError";
  }
}

function parsePermissionShellCommand(command: string): ReturnType<typeof parse> {
  try {
    // shell-quote otherwise splits operators inside unquoted Bash prefix/suffix trim patterns.
    // Skip quoted/escaped text; only shield literal patterns, never executable substitutions.
    const escapedCommand = stripPermissionShellHeredocs(command).replace(
      /\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\$\{(?:[a-zA-Z_]\w*|\d+|[@*#?$!-])(?:%%?|##?)[^'"`\\${}()<>\r\n]*\}/g,
      (token) => (token.startsWith("${") ? token.replace(/[|&; \t]/g, "\\$&") : token),
    );
    // Only deterministic tokenization uses this spelling; review/execution keep the original input.
    return parse(escapedCommand);
  } catch {
    throw new PermissionShellParseError();
  }
}

function inlineJavaScriptSourceIndex(words: string[]): number | undefined {
  const executableIndex = words.findIndex((word) => !/^[a-zA-Z_]\w*=/.test(word));
  const executable = words[executableIndex]?.split("/").at(-1) ?? "";
  if (!["node", "nodejs", "bun", "tsx"].includes(executable)) return undefined;
  for (let index = executableIndex + 1; index < words.length; index++) {
    const word = words[index] ?? "";
    if (["-e", "--eval", "-p", "--print", "-pe"].includes(word))
      return index + 1 < words.length ? index + 1 : undefined;
    if (/^--(?:eval|print)=/.test(word)) return index;
    if (/^--[\w-]+=/.test(word)) continue;
    if (
      [
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
        "--input-type",
        "-C",
        "--conditions",
        "--title",
      ].includes(word)
    ) {
      index++;
      continue;
    }
    if (["--no-warnings", "--enable-source-maps"].includes(word)) continue;
    // Stop at a script, --, or an unknown option whose argument arity is ambiguous.
    return undefined;
  }
  return undefined;
}

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)|^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, homedir());
}

function matches(pattern: string, value: string): boolean {
  const regex = expandHome(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "s").test(value);
}

function surfaceDecision(
  config: PermissionConfig,
  surface: string,
  values: string[],
  fallback: PermissionAction,
): DeterministicDecision {
  const policy = Object.hasOwn(config.permission, surface) ? config.permission[surface] : undefined;
  let decision = { action: fallback, rule: `${surface}: fallback` };
  if (typeof policy === "string") return { action: policy, rule: surface };
  for (const [pattern, action] of Object.entries(policy ?? {})) {
    if (values.some((value) => matches(pattern, value)))
      decision = { action, rule: `${surface}: ${pattern}` };
  }
  return decision;
}

function strongest(decisions: DeterministicDecision[]): DeterministicDecision {
  return decisions.reduce((winner, next) =>
    rank[next.action] > rank[winner.action] ? next : winner,
  );
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["ENOENT", "ENAMETOOLONG"].includes(String(error.code))
    )
      throw error;
    // A long shell argument may be message text; still resolve ancestors for path-policy checks.
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent), relative(parent, path));
  }
}

async function resolveReadPermissionPath(
  path: string,
): Promise<{ resolved: string; canonical: string }> {
  const nfd = path.normalize("NFD");
  const variants = [
    path,
    path.replace(/ (AM|PM)\./gi, "\u202f$1."),
    nfd,
    path.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
  // Follow Pi 1.1's read fallback order before evaluating the target's permissions.
  for (const candidate of new Set(variants)) {
    try {
      return { resolved: candidate, canonical: await realpath(candidate) };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR"].includes(String(error.code))
      )
        throw error;
    }
  }
  return { resolved: path, canonical: await canonicalPath(path) };
}

async function pathDecisions(
  config: PermissionConfig,
  rawPath: string,
  cwd: string,
  direction: "read" | "write" | "unknown",
  tool?: string,
): Promise<DeterministicDecision[]> {
  let normalized = rawPath.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  const native = tool !== undefined && nativePathTools.has(tool);
  if (native && normalized.startsWith("@")) normalized = normalized.slice(1);
  normalized = normalized.startsWith("file://")
    ? fileURLToPath(normalized)
    : native
      ? normalized.replace(/^~(?=\/|$)/, homedir())
      : expandHome(normalized);
  const requested = resolve(cwd, normalized);
  const { resolved, canonical } =
    tool === "read"
      ? await resolveReadPermissionPath(requested)
      : { resolved: requested, canonical: await canonicalPath(requested) };
  const root = await canonicalPath(cwd);
  const groups = [
    [rawPath, requested, relative(cwd, requested)],
    [resolved, relative(cwd, resolved)],
    [canonical, relative(root, canonical)],
  ];
  const decisions: DeterministicDecision[] = [];
  const directions = direction === "unknown" ? ["read", "write"] : [direction];
  for (const values of groups) {
    const base = surfaceDecision(config, "path", values, "allow");
    for (const axis of directions)
      decisions.push(surfaceDecision(config, `path_${axis}`, values, base.action));
    if (tool)
      decisions.push(
        surfaceDecision(config, tool, values, surfaceDecision(config, "*", [tool], "ask").action),
      );
  }
  const outside = relative(root, canonical);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    const values = [resolved, canonical];
    const base = surfaceDecision(config, "external_directory", values, "ask");
    for (const axis of directions)
      decisions.push(surfaceDecision(config, `external_directory_${axis}`, values, base.action));
  }
  return decisions;
}

/** Apply cross-cutting paths and tool rules before any classifier request. */
export async function decideDeterministicPermission(
  config: PermissionConfig,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<DeterministicDecision> {
  const fallback = surfaceDecision(config, "*", [tool], "ask").action;
  const value =
    tool === "code_format" || tool === "code_ast"
      ? input.apply === true
        ? "apply"
        : "preview"
      : tool;
  const decisions: DeterministicDecision[] = [surfaceDecision(config, tool, [value], fallback)];
  const path =
    typeof input.path === "string"
      ? input.path
      : input.arguments &&
          typeof input.arguments === "object" &&
          "path" in input.arguments &&
          typeof input.arguments.path === "string"
        ? input.arguments.path
        : undefined;
  if (path !== undefined) {
    const previewTool = tool === "code_format" || tool === "code_ast";
    const direction =
      readers.has(tool) || (previewTool && input.apply !== true)
        ? "read"
        : tool === "write" || tool === "edit" || (previewTool && input.apply === true)
          ? "write"
          : "unknown";
    // Preview/apply maps select an operation, while file-tool maps select a path.
    if (!previewTool) decisions.length = 0;
    decisions.push(
      ...(await pathDecisions(config, path, cwd, direction, previewTool ? undefined : tool)),
    );
  }
  if (tool === "bash") {
    if (typeof input.command !== "string" || !input.command.trim())
      return { action: "ask", rule: "bash: missing command" };
    const command = input.command.trim();
    decisions.length = 0;
    decisions.push(surfaceDecision(config, "bash", [command], fallback));
    let words: string[] = [];
    const commandUnits: string[][] = [];
    // Trailing whitespace can distinguish a heredoc delimiter from ordinary body content.
    const tokens = parsePermissionShellCommand(input.command);
    for (const token of tokens) {
      if (typeof token === "string") words.push(token);
      else {
        commandUnits.push(words);
        words = [];
      }
    }
    commandUnits.push(words);
    for (const unitWords of commandUnits) {
      const sourceIndex = inlineJavaScriptSourceIndex(unitWords);
      if (sourceIndex !== undefined)
        decisions.push({ action: "ask", rule: "bash: inline JavaScript requires review" });
      for (const [index, token] of unitWords.entries()) {
        // Inline source is code, not a filename; the reviewer receives the unchanged command.
        if (index === sourceIndex) continue;
        const candidate = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
        if (candidate && !candidate.startsWith("-") && !candidate.includes("\0")) {
          decisions.push(...(await pathDecisions(config, candidate, cwd, "unknown")));
        }
      }
      const unit = surfaceDecision(config, "bash", [unitWords.join(" ")], fallback);
      if (unit.action === "deny") decisions.push(unit);
    }
    // Shell syntax, indirection, and expansions cannot be proven safe by a prefix glob.
    if (
      !/^[a-zA-Z0-9_./:@%+=, -]+$/.test(command) ||
      /^(?:\S*\/)?(?:sh|bash|zsh|eval|sudo|env|xargs)\b/.test(command) ||
      /\bfind\b.*-(?:exec|execdir|delete)\b/.test(command)
    ) {
      decisions.push({ action: "ask", rule: "bash: complex or indirect command" });
    }
  }
  return strongest(decisions);
}
