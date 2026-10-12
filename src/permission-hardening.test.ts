import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

test("a symlink alias cannot turn a protected read into a deterministic allowance", async () => {
  const fixture = await createPermissionSession();
  try {
    await writeFile(join(fixture.cwd, "private.env"), "synthetic secret");
    await symlink(join(fixture.cwd, "private.env"), join(fixture.cwd, "private.env.example"));
    const result = await fixture.run("read", { path: "private.env.example" });
    assert.equal(result.isError, true);
    assert.doesNotMatch(permissionResultText(result), /synthetic secret/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("Pi's leading-at path syntax cannot bypass an auth-file denial", async () => {
  const fixture = await createPermissionSession();
  try {
    await writeFile(join(fixture.cwd, "auth.json"), "synthetic fixture");
    const result = await fixture.run("read", { path: "@auth.json" });
    assert.equal(result.isError, true);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

for (const [requested, actual] of [
  ["café.txt", "cafe\u0301.txt"],
  ["capture's.txt", "capture\u2019s.txt"],
  ["Screenshot 2 PM.txt", "Screenshot 2\u202fPM.txt"],
] as const) {
  test(`Pi's filename alias '${requested}' cannot bypass a canonical protected path`, async () => {
    const fixture = await createPermissionSession();
    try {
      await writeFile(join(fixture.cwd, "auth.json"), "synthetic fixture");
      await symlink(join(fixture.cwd, "auth.json"), join(fixture.cwd, actual));
      const result = await fixture.run("read", { path: requested });
      assert.equal(result.isError, true);
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

test("a denied command in a shell chain stays denied even behind an allowed prefix", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { bash: { "*": "ask", "printf *": "allow", "rm *": "deny" } } },
  });
  try {
    await writeFile(join(fixture.cwd, "victim.txt"), "survives");
    const result = await fixture.run("bash", { command: "printf okay && rm victim.txt" });
    assert.equal(result.isError, true);
    assert.equal(await readFile(join(fixture.cwd, "victim.txt"), "utf8"), "survives");
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("shell redirection is reviewed, not silently granted by a prefix glob", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { bash: { "printf *": "allow" } } },
    classify: async (context) => permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "unclear"),
  });
  try {
    const result = await fixture.run("bash", { command: "printf unsafe > redirected.txt" });
    assert.equal(result.isError, true);
    assert.equal(fixture.requests.length, 1);
    await assert.rejects(readFile(join(fixture.cwd, "redirected.txt")), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("a literal allowed shell command executes without a classifier request", async () => {
  const fixture = await createPermissionSession();
  try {
    const result = await fixture.run("bash", { command: "pwd" });
    assert.equal(result.isError, false);
    assert.match(permissionResultText(result), /pi-auto-perms-test-/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("format previews can bypass review but applying changes cannot", async () => {
  const fixture = await createPermissionSession({
    extension: (pi) =>
      pi.registerTool({
        name: "code_format",
        label: "Fixture formatting",
        description: "Return a fixture preview",
        parameters: Type.Object({ path: Type.String(), apply: Type.Optional(Type.Boolean()) }),
        execute: async () => ({
          content: [{ type: "text", text: "preview available" }],
          details: undefined,
        }),
      }),
  });
  try {
    const preview = await fixture.run("code_format", { path: "format.ts", apply: false });
    assert.equal(preview.isError, false);
    assert.match(permissionResultText(preview), /preview available/);
    assert.equal(fixture.requests.length, 0);
    const apply = await fixture.run("code_format", { path: "format.ts", apply: true });
    assert.equal(apply.isError, true);
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("an allowed orchestrating tool cannot bypass permission review on its nested write", async () => {
  let permitted = false;
  const fixture = await createPermissionSession({
    global: { permission: { orchestrate: "allow" } },
    classify: async (context) =>
      permitted
        ? permissionAnswer(context)
        : permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
    extension: (pi) =>
      pi.registerTool({
        name: "orchestrate",
        label: "Fixture orchestrator",
        description: "Exercise nested Pi tool execution",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async (_id, args, _signal, _onUpdate, ctx) => {
          const outcome = await ctx.executeTool("write", args);
          return { ...outcome.result, isError: outcome.isError };
        },
      }),
  });
  try {
    const denied = await fixture.run("orchestrate", {
      path: "nested.txt",
      content: "nested write",
    });
    assert.equal(denied.isError, true);
    await assert.rejects(readFile(join(fixture.cwd, "nested.txt")), { code: "ENOENT" });
    assert.equal(denied.nestedCalls?.calls[0]?.status, "error");
    permitted = true;
    const allowed = await fixture.run("orchestrate", {
      path: "nested.txt",
      content: "nested write",
    });
    assert.equal(allowed.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "nested.txt"), "utf8"), "nested write");
    assert.deepEqual(
      fixture.requests.map((request) => request.state.tool),
      [
        { name: "write", input: { path: "nested.txt", content: "nested write" } },
        { name: "write", input: { path: "nested.txt", content: "nested write" } },
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("obvious inline credentials are not sent to a permission provider", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run("write", {
      path: "credentials.txt",
      content: "Authorization: Bearer fixture-secret-value",
    });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /credential/i);
    assert.equal(fixture.requests.length, 0);
    await assert.rejects(readFile(join(fixture.cwd, "credentials.txt")), { code: "ENOENT" });
    const next = await fixture.run("write", { path: "normal.txt", content: "not a secret" });
    assert.equal(next.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "normal.txt"), "utf8"), "not a secret");
  } finally {
    await fixture.close();
  }
});

test("oversized actions are blocked rather than approved from truncated evidence", async () => {
  const fixture = await createPermissionSession({
    global: { maxReviewChars: 4096 },
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run("write", { path: "huge.txt", content: "x".repeat(5000) });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /nothing was truncated/);
    assert.equal(fixture.requests.length, 0);
    await assert.rejects(readFile(join(fixture.cwd, "huge.txt")), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});
