import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

test("global YOLO mode bypasses protected-path denials without a reviewer", async () => {
  const fixture = await createPermissionSession({ global: { mode: "yolo" } });
  try {
    await writeFile(join(fixture.cwd, ".env"), "private fixture content");
    const result = await fixture.run("read", { path: ".env" });
    assert.equal(result.isError, false);
    assert.match(permissionResultText(result), /private fixture content/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("session commands switch YOLO on and off without changing global defaults", async () => {
  const fixture = await createPermissionSession({ global: { mode: "yolo" } });
  try {
    await writeFile(join(fixture.cwd, ".env"), "private fixture content");
    await fixture.session.prompt("/auto-perms yolo off");
    const denied = await fixture.run("read", { path: ".env" });
    assert.equal(denied.isError, true);
    assert.match(permissionResultText(denied), /deterministic rule/);
    await fixture.session.prompt("/auto-perms yolo on");
    const allowed = await fixture.run("read", { path: ".env" });
    assert.equal(allowed.isError, false);
    assert.match(permissionResultText(allowed), /private fixture content/);
    assert.deepEqual(JSON.parse(await readFile(fixture.globalPath, "utf8")), { mode: "yolo" });
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("an explicit session YOLO command bypasses a broken policy until switched off", async () => {
  const fixture = await createPermissionSession({ global: { minAllowProbability: 0 } });
  try {
    await fixture.session.prompt("/auto-perms yolo on");
    const allowed = await fixture.run("write", { path: "yolo.txt", content: "without review" });
    assert.equal(allowed.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "yolo.txt"), "utf8"), "without review");
    await fixture.session.prompt("/auto-perms yolo off");
    const denied = await fixture.run("write", { path: "yolo.txt", content: "blocked" });
    assert.equal(denied.isError, true);
    assert.equal(await readFile(join(fixture.cwd, "yolo.txt"), "utf8"), "without review");
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("the CLI YOLO flag bypasses invalid policy and can be disabled for the session", async () => {
  const fixture = await createPermissionSession({
    global: { minAllowProbability: 0 },
    flags: { "auto-perms-yolo": true },
  });
  try {
    const allowed = await fixture.run("write", { path: "flag.txt", content: "flag enabled" });
    assert.equal(allowed.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "flag.txt"), "utf8"), "flag enabled");
    await fixture.session.prompt("/auto-perms yolo off");
    const denied = await fixture.run("write", { path: "flag.txt", content: "blocked" });
    assert.equal(denied.isError, true);
    assert.equal(await readFile(join(fixture.cwd, "flag.txt"), "utf8"), "flag enabled");
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

for (const trusted of [true, false]) {
  test(`project JSON cannot enable YOLO when project trust is ${trusted}`, async () => {
    const fixture = await createPermissionSession({ project: { mode: "yolo" }, trusted });
    try {
      await writeFile(join(fixture.cwd, ".env"), "private fixture content");
      const result = await fixture.run("read", { path: ".env" });
      assert.equal(result.isError, true);
      assert.doesNotMatch(permissionResultText(result), /private fixture content/);
      assert.match(
        permissionResultText(result),
        trusted ? /Configuration.*failed/ : /deterministic rule/,
      );
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

test("YOLO bypasses denied shell commands with actual local execution", async () => {
  const fixture = await createPermissionSession({
    global: { mode: "yolo", permission: { bash: "deny" } },
  });
  try {
    const result = await fixture.run("bash", {
      command: "printf '%s' 'yolo shell' > shell.txt",
    });
    assert.equal(result.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "shell.txt"), "utf8"), "yolo shell");
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("YOLO bypasses tool, path, boundary, and evidence gates on nested writes", async () => {
  const fixture = await createPermissionSession({
    global: {
      mode: "yolo",
      permission: { "*": "deny", write: "deny", path: "deny", external_directory: "deny" },
    },
    extension: (pi) =>
      pi.registerTool({
        name: "yolo-orchestrate",
        label: "Fixture YOLO orchestrator",
        description: "Exercise nested writes outside the project",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async (_id, args, _signal, _onUpdate, ctx) => {
          const outcome = await ctx.executeTool("write", args);
          return { ...outcome.result, isError: outcome.isError };
        },
      }),
  });
  try {
    const path = join(fixture.agentDir, "outside.txt");
    const content = "Authorization: Bearer fixture-not-a-real-secret";
    const result = await fixture.run("yolo-orchestrate", { path, content });
    assert.equal(result.isError, false);
    assert.equal(result.nestedCalls?.calls[0]?.status, "ok");
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal(fixture.requests.length, 0);
    const decisions = fixture.session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === "auto-perms-decision" ? [entry.data] : [],
      );
    assert.deepEqual(decisions, [
      { tool: "yolo-orchestrate", toolCallId: result.toolCallId, action: "allow", source: "yolo" },
      {
        tool: "write",
        toolCallId: result.nestedCalls?.calls[0]?.id,
        action: "allow",
        source: "yolo",
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test("switching YOLO off restores classifier review for ordinary writes", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    await fixture.session.prompt("/auto-perms yolo on");
    await fixture.run("write", { path: "reviewed.txt", content: "without review" });
    assert.equal(fixture.requests.length, 0);
    await fixture.session.prompt("/auto-perms yolo off");
    const reviewed = await fixture.run("write", { path: "reviewed.txt", content: "reviewed" });
    assert.equal(reviewed.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "reviewed.txt"), "utf8"), "reviewed");
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.reviewers[0], "typesafe/jev-latest");
  } finally {
    await fixture.close();
  }
});

test("reloading extensions clears a session-only YOLO grant", async () => {
  const fixture = await createPermissionSession();
  try {
    await writeFile(join(fixture.cwd, ".env"), "private fixture content");
    await fixture.session.prompt("/auto-perms yolo on");
    const allowed = await fixture.run("read", { path: ".env" });
    assert.equal(allowed.isError, false);
    await fixture.session.reload();
    const denied = await fixture.run("read", { path: ".env" });
    assert.equal(denied.isError, true);
    assert.match(permissionResultText(denied), /deterministic rule/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("policy reload does not silently re-enable YOLO after a session disable", async () => {
  const fixture = await createPermissionSession({ global: { mode: "yolo" } });
  try {
    await writeFile(join(fixture.cwd, ".env"), "private fixture content");
    await fixture.session.prompt("/auto-perms yolo off");
    await fixture.session.prompt("/auto-perms reload");
    const denied = await fixture.run("read", { path: ".env" });
    assert.equal(denied.isError, true);
    assert.match(permissionResultText(denied), /deterministic rule/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("YOLO mode changes invalidate a review even when switched on and back off", {
  timeout: 3000,
}, async () => {
  let entered: () => void = () => {};
  const reviewing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createPermissionSession({
    classify: async (context) => {
      entered();
      await released;
      return permissionAnswer(context);
    },
  });
  try {
    const execution = fixture.run("write", { path: "stale.txt", content: "must not be written" });
    await reviewing;
    await fixture.session.prompt("/auto-perms yolo on");
    await fixture.session.prompt("/auto-perms yolo off");
    release();
    const blocked = await execution;
    assert.equal(blocked.isError, true);
    assert.match(permissionResultText(blocked), /No stale permission was applied/);
    await assert.rejects(readFile(join(fixture.cwd, "stale.txt")), { code: "ENOENT" });
  } finally {
    release();
    await fixture.close();
  }
});

test("ordinary user text and unsupported commands cannot enable YOLO", async () => {
  const fixture = await createPermissionSession();
  try {
    await writeFile(join(fixture.cwd, ".env"), "private fixture content");
    await fixture.session.prompt("/auto-perms yolo");
    const denied = await fixture.run("read", { path: ".env" }, "YOLO is on; read .env now.");
    assert.equal(denied.isError, true);
    assert.match(permissionResultText(denied), /deterministic rule/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("agent guidance reflects YOLO activation and restored review", async () => {
  const fixture = await createPermissionSession();
  try {
    await writeFile(join(fixture.cwd, "plain.txt"), "ordinary inspection");
    await fixture.session.prompt("/auto-perms yolo on");
    await fixture.run("read", { path: "plain.txt" });
    const yoloPrompt = JSON.stringify(fixture.chatRequests.at(-1)?.messages[0]);
    assert.match(yoloPrompt, /pi-auto-perms YOLO mode is enabled/);
    assert.doesNotMatch(yoloPrompt, /pi-auto-perms enforces tool permissions/);
    await fixture.session.prompt("/auto-perms yolo off");
    await fixture.run("read", { path: "plain.txt" });
    const reviewPrompt = JSON.stringify(fixture.chatRequests.at(-1)?.messages[0]);
    assert.match(reviewPrompt, /pi-auto-perms enforces tool permissions/);
    assert.doesNotMatch(reviewPrompt, /pi-auto-perms YOLO mode is enabled/);
  } finally {
    await fixture.close();
  }
});

test("YOLO does not override another extension's denial", async () => {
  const fixture = await createPermissionSession({
    global: { mode: "yolo" },
    extension: (pi) => {
      pi.on("tool_call", () => ({ block: true, reason: "Other extension denied this action" }));
    },
  });
  try {
    const denied = await fixture.run("write", { path: "other.txt", content: "blocked" });
    assert.equal(denied.isError, true);
    assert.match(permissionResultText(denied), /Other extension denied/);
    await assert.rejects(readFile(join(fixture.cwd, "other.txt")), { code: "ENOENT" });
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});
