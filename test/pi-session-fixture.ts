import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type ClassifierContext,
  type ClassifierResult,
  createAssistantMessageEventStream,
  type JsonObject,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import autoPermsExtension from "../src/auto-perms-extension.ts";

/** A real isolated Pi session; only the external chat/classifier services are faked. */
export async function createPermissionSession(
  options: {
    global?: unknown;
    project?: unknown;
    trusted?: boolean;
    attemptsPerTurn?: number;
    followingCalls?: { name: string; arguments: JsonObject }[];
    extension?: ExtensionFactory;
    classify?: (context: ClassifierContext) => Promise<ClassifierResult>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-perms-test-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const globalPath = join(agentDir, "auto-perms.json");
  const projectPath = join(cwd, ".pi", "auto-perms.json");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), "{}");
  if (options.global !== undefined) await writeFile(globalPath, JSON.stringify(options.global));
  if (options.project !== undefined) await writeFile(projectPath, JSON.stringify(options.project));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultProjectTrust: options.trusted === false ? "never" : "always",
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const requests: ClassifierContext[] = [];
  const reviewers: string[] = [];
  runtime.classify = async (model, context) => {
    requests.push(context);
    reviewers.push(`${model.provider}/${model.id}`);
    if (options.classify) return options.classify(context);
    throw new Error("Unexpected classifier request");
  };

  let action = { name: "read", arguments: {} as JsonObject };
  runtime.registerProvider("permission-fixture", {
    apiKey: "fixture-not-a-real-key",
    api: "permission-fixture",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple: (model, context) => {
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const results = context.messages
        .slice(lastUser + 1)
        .filter((message) => message.role === "toolResult");
      const hasResult = results.length >= (options.attemptsPerTurn ?? 1);
      const message: AssistantMessage = {
        role: "assistant",
        content: hasResult
          ? [{ type: "text", text: "Done" }]
          : [
              {
                type: "toolCall",
                id: `fixture-call-${results.length}`,
                ...(results.length > 0
                  ? (options.followingCalls?.[results.length - 1] ?? action)
                  : action),
              },
            ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: hasResult ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: hasResult ? "stop" : "toolUse", message });
      return stream;
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [autoPermsExtension, ...(options.extension ? [options.extension] : [])],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.trusted !== false });
  const model = runtime.getModel("permission-fixture", "fixture");
  if (!model) throw new Error("Fixture model was not registered");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["*"],
    thinkingLevel: "off",
  });
  await session.bindExtensions({});

  return {
    session,
    cwd,
    agentDir,
    globalPath,
    projectPath,
    requests,
    reviewers,
    setProjectTrusted(trusted: boolean) {
      settingsManager.setProjectTrusted(trusted);
    },
    async run(
      name: string,
      args: JsonObject,
      prompt = "Work on this project.",
      source: "interactive" | "extension" = "interactive",
    ) {
      action = { name, arguments: args };
      await session.prompt(prompt, { source });
      const result = session.messages.filter((message) => message.role === "toolResult").at(-1);
      if (!result) throw new Error("Fixture did not receive a tool result");
      return result;
    },
    async close() {
      session.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Read the model-facing text from a real Pi tool outcome. */
export function permissionResultText(result: {
  content: { type: string; text?: string }[];
}): string {
  return result.content
    .flatMap((item) => (item.type === "text" ? [item.text ?? ""] : []))
    .join("\n");
}

/** A normalized successful classifier response, independent of any live service. */
export function permissionAnswer(
  context: ClassifierContext,
  allow = 0.98,
  deny = 0.01,
  ask = 0.01,
  choice = "allow",
  reason = "allowed",
): ClassifierResult {
  const question = context.questions.reason;
  if (question?.type !== "choice") throw new Error("Fixture expected a reason question");
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers: {
      permission: { type: "choice", choice, probabilities: { allow, deny, ask }, confidence: 0.99 },
      reason: {
        type: "choice",
        choice: reason,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((key) => [key, key === reason ? 1 : 0]),
        ),
        confidence: 1,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
