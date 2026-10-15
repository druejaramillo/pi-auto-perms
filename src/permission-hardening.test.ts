import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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

for (const [description, message] of [
  ["ASCII", "x".repeat(256)],
  ["multibyte", "é".repeat(128)],
  ["multiline email body", "Synthetic portfolio description.\n".repeat(100)],
] as const) {
  test(`a long ${description} shell argument reaches review intact instead of failing as a filename`, async () => {
    const fixture = await createPermissionSession({
      classify: async (context) => permissionAnswer(context),
    });
    try {
      const command = `printf '%s' '${message}'`;
      const result = await fixture.run("bash", { command });
      assert.equal(result.isError, false, permissionResultText(result));
      assert.equal(permissionResultText(result), message);
      assert.equal(fixture.requests.length, 1);
      assert.deepEqual(fixture.requests[0]?.state.tool, { name: "bash", input: { command } });
    } finally {
      await fixture.close();
    }
  });
}

test("an overlong shell argument still obeys a lexical protected-path denial", async () => {
  const fixture = await createPermissionSession();
  try {
    const result = await fixture.run("bash", { command: `printf '%s' '${"x".repeat(256)}.env'` });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Denied by deterministic rule.*path_/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("an overlong shell path still obeys a canonical symlink-parent denial", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { path: { "*/protected/*": "deny" } } },
  });
  try {
    await mkdir(join(fixture.cwd, "protected"));
    await symlink(join(fixture.cwd, "protected"), join(fixture.cwd, "alias"));
    const result = await fixture.run("bash", {
      command: `printf '%s' 'alias/${"x".repeat(256)}'`,
    });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Denied by deterministic rule.*protected/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a symlink-loop error still fails closed before shell review", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    await symlink("loop", join(fixture.cwd, "loop"));
    const result = await fixture.run("bash", { command: "printf '%s' loop/message.txt" });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Permission evaluation failed/);
    assert.doesNotMatch(permissionResultText(result), /Configuration|reload/);
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

test("credential-shaped fixtures reach write/edit review without poisoning later user context", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run("write", {
      path: "credentials.txt",
      content: "Authorization: Bearer fixture-secret-value",
    });
    assert.equal(result.isError, false, permissionResultText(result));
    assert.equal(fixture.requests.length, 1);
    const content = await readFile(join(fixture.cwd, "credentials.txt"), "utf8");
    assert.deepEqual(fixture.requests[0]?.state.tool, {
      name: "write",
      input: { path: "credentials.txt", content },
    });
    const prompt = `Update this synthetic test fixture: ${content}`;
    const editedContent = `${content}\n// updated fixture`;
    const editInput = {
      path: "credentials.txt",
      edits: [{ oldText: content, newText: editedContent }],
    };
    const edited = await fixture.run("edit", editInput, prompt);
    assert.equal(edited.isError, false, permissionResultText(edited));
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests[1]?.state.tool, { name: "edit", input: editInput });
    assert.equal(await readFile(join(fixture.cwd, "credentials.txt"), "utf8"), editedContent);
    const next = await fixture.run("write", { path: "normal.txt", content: "not a secret" });
    assert.equal(next.isError, false, permissionResultText(next));
    assert.equal(await readFile(join(fixture.cwd, "normal.txt"), "utf8"), "not a secret");
    assert.equal(fixture.requests.length, 3);
    const userMessages = fixture.requests[2]?.state.userMessages;
    assert.ok(Array.isArray(userMessages));
    assert.ok(userMessages.includes(prompt));
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
