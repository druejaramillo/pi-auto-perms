import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const actionSchema = z.enum(["allow", "deny", "ask"]);
const surfaceSchema = z.union([actionSchema, z.record(z.string().min(1), actionSchema)]);
const ruleSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/),
  effect: z.enum(["allow", "deny"]),
  when: z.string().trim().min(1),
});
const policyShape = {
  version: z.literal(1).optional(),
  permission: z.record(z.string().min(1), surfaceSchema).optional(),
  rules: z.array(ruleSchema).max(100).refine(
    (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
    "Rule IDs must be unique within each configuration file",
  ).optional(),
};
const projectSchema = z.strictObject(policyShape);
const globalSchema = z.strictObject({
  ...policyShape,
  reviewer: z.strictObject({
    provider: z.enum(["typesafe", "cloudflare-workers-ai", "openai"]),
    model: z.string().trim().min(1),
  }).optional(),
  minAllowProbability: z.number().gt(0.5).lte(1).optional(),
  reviewTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  historyLimit: z.number().int().min(1).max(20).optional(),
  maxReviewChars: z.number().int().min(1024).max(128_000).optional(),
});

/** Deterministic permission states; ask always means non-interactive model review. */
export type PermissionAction = z.infer<typeof actionSchema>;
/** A plain-language rule, replaced across scopes by its stable ID. */
export type PermissionRule = z.infer<typeof ruleSchema>;
/** Fully validated effective configuration, with no embedded credentials. */
export interface PermissionConfig {
  reviewer: { provider: "typesafe" | "cloudflare-workers-ai" | "openai"; model: string };
  minAllowProbability: number;
  reviewTimeoutMs: number;
  historyLimit: number;
  maxReviewChars: number;
  permission: Record<string, z.infer<typeof surfaceSchema>>;
  rules: PermissionRule[];
}

const defaultConfig: PermissionConfig = {
  reviewer: { provider: "typesafe", model: "jev-latest" },
  minAllowProbability: 0.95,
  reviewTimeoutMs: 5000,
  historyLimit: 3,
  maxReviewChars: 32_000,
  permission: {
    "*": "ask",
    read: "allow", grep: "allow", find: "allow", ls: "allow",
    code_lsp: "allow", code_check: "allow",
    code_format: { "*": "ask", preview: "allow" },
    code_ast: { "*": "ask", preview: "allow" },
    path: {
      "*": "allow",
      "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow",
      "*/.ssh/*": "deny", "*/auth.json": "deny", "*.key": "deny",
    },
    external_directory_read: {
      "*": "ask",
      "~/.pi/agent/skills/*": "allow", "~/.agents/skills/*": "allow",
      "~/.pi/agent/references/*": "allow", "~/.agents/references/*": "allow",
      "~/.pi/agent/AGENTS.md": "allow",
    },
    external_directory_write: "ask",
    bash: {
      "*": "ask", pwd: "allow", "git status": "allow",
      "git status --short": "allow", "git diff --stat": "allow",
    },
  },
  rules: [
    {
      id: "routine-development", effect: "allow",
      when: "The action is routine local development, inspection, testing, or editing needed for the user's task, or the user explicitly authorized this specific action within the current task's scope.",
    },
    {
      id: "explicit-authorization", effect: "deny",
      when: "The action publishes, pushes, deploys, spends money, makes irreversible changes, or accesses unrelated private data without explicit applicable authorization from the user.",
    },
    {
      id: "private-data", effect: "deny",
      when: "The action exposes private data or credentials to a recipient the user did not authorize, or disregards the user's most recent refusal of this action.",
    },
  ],
};

async function readPolicyFile<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`pi-auto-perms: Cannot read configuration ${path}`);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`pi-auto-perms: Invalid JSON in ${path}`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
    throw new Error(`pi-auto-perms: Invalid configuration ${path}: ${issues.join("; ")}`);
  }
  return parsed.data;
}

function mergePolicy(base: PermissionConfig, scope: z.infer<typeof projectSchema>): PermissionConfig {
  const permission = { ...base.permission };
  for (const [surface, next] of Object.entries(scope.permission ?? {})) {
    const prior = permission[surface];
    permission[surface] = typeof prior === "object" && typeof next === "object"
      ? Object.fromEntries([
        ...Object.entries(prior).filter(([key]) => !Object.hasOwn(next, key)),
        ...Object.entries(next),
      ])
      : next;
  }
  const replaced = new Set(scope.rules?.map((rule) => rule.id));
  return {
    ...base, permission,
    rules: [...base.rules.filter((rule) => !replaced.has(rule.id)), ...(scope.rules ?? [])],
  };
}

/** Load global settings and trusted project overrides once per session/reload. */
export async function loadPermissionConfig(agentDir: string, cwd: string, projectTrusted: boolean): Promise<PermissionConfig> {
  const global = await readPolicyFile(join(agentDir, "auto-perms.json"), globalSchema);
  const config: PermissionConfig = {
    ...mergePolicy(defaultConfig, global ?? {}),
    reviewer: global?.reviewer ?? defaultConfig.reviewer,
    minAllowProbability: global?.minAllowProbability ?? defaultConfig.minAllowProbability,
    reviewTimeoutMs: global?.reviewTimeoutMs ?? defaultConfig.reviewTimeoutMs,
    historyLimit: global?.historyLimit ?? defaultConfig.historyLimit,
    maxReviewChars: global?.maxReviewChars ?? defaultConfig.maxReviewChars,
  };
  if (!projectTrusted) return config;
  const project = await readPolicyFile(join(cwd, ".pi", "auto-perms.json"), projectSchema);
  return project ? mergePolicy(config, project) : config;
}
