import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

test("new user instructions invalidate an approval still being evaluated", {
  timeout: 3000,
}, async () => {
  let entered: () => void = () => {};
  const reviewing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: ((value: ClassifierResult) => void) | undefined;
  let calls = 0;
  const fixture = await createPermissionSession({
    classify: (context) => {
      calls += 1;
      if (calls > 1)
        return Promise.resolve(
          permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
        );
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const execution = fixture.run("write", {
      path: "changed-mind.txt",
      content: "must not be written",
    });
    await reviewing;
    await fixture.session.prompt("Do not create changed-mind.txt.", {
      streamingBehavior: "steer",
      source: "interactive",
    });
    const context = fixture.requests[0];
    assert.ok(context);
    release?.(permissionAnswer(context));
    await execution;
    const outcomes = fixture.session.messages.filter((message) => message.role === "toolResult");
    assert.ok(outcomes[0]);
    assert.equal(outcomes[0].isError, true);
    assert.match(permissionResultText(outcomes[0]), /user context.*changed/);
    await assert.rejects(readFile(join(fixture.cwd, "changed-mind.txt")), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("review history stays bounded and the most recent refusal reaches the reviewer", async () => {
  const fixture = await createPermissionSession({
    global: { historyLimit: 2 },
    classify: async (context) =>
      Array.isArray(context.state.userMessages) &&
      context.state.userMessages.at(-1) === "Do not replace history.txt."
        ? permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data")
        : permissionAnswer(context),
  });
  try {
    await fixture.run("write", { path: "history.txt", content: "first" }, "Create history.txt.");
    await fixture.run(
      "write",
      { path: "history.txt", content: "second" },
      "Replace it with second.",
    );
    const denied = await fixture.run(
      "write",
      { path: "history.txt", content: "wrong" },
      "Do not replace history.txt.",
    );
    assert.equal(denied.isError, true);
    assert.equal(await readFile(join(fixture.cwd, "history.txt"), "utf8"), "second");
    assert.deepEqual(fixture.requests[2]?.state.userMessages, [
      "Replace it with second.",
      "Do not replace history.txt.",
    ]);
  } finally {
    await fixture.close();
  }
});

test("an uncertain action cannot be repeatedly reviewed until a new user reply arrives", async () => {
  let calls = 0;
  const fixture = await createPermissionSession({
    attemptsPerTurn: 2,
    classify: async (context) =>
      ++calls === 1
        ? permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "needs_approval")
        : permissionAnswer(context),
  });
  try {
    const first = await fixture.run("write", {
      path: "wait-for-user.txt",
      content: "only after reply",
    });
    assert.equal(first.isError, true);
    assert.equal(fixture.requests.length, 1);
    assert.match(permissionResultText(first), /Awaiting a new user reply/);
    await assert.rejects(readFile(join(fixture.cwd, "wait-for-user.txt")), { code: "ENOENT" });
    const approved = await fixture.run(
      "write",
      { path: "wait-for-user.txt", content: "only after reply" },
      "Yes, create wait-for-user.txt with that content.",
    );
    assert.equal(approved.isError, false);
    assert.equal(
      await readFile(join(fixture.cwd, "wait-for-user.txt"), "utf8"),
      "only after reply",
    );
  } finally {
    await fixture.close();
  }
});

test("a clear denial still lets the agent pursue an independently permitted alternative", async () => {
  let calls = 0;
  const fixture = await createPermissionSession({
    attemptsPerTurn: 2,
    followingCalls: [
      { name: "write", arguments: { path: "safe.txt", content: "safe alternative" } },
    ],
    classify: async (context) =>
      ++calls === 1
        ? permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data")
        : permissionAnswer(context),
  });
  try {
    const result = await fixture.run("write", {
      path: "unsafe.txt",
      content: "must not be written",
    });
    assert.equal(result.isError, false);
    await assert.rejects(readFile(join(fixture.cwd, "unsafe.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.cwd, "safe.txt"), "utf8"), "safe alternative");
    assert.equal(fixture.requests.length, 2);
    assert.equal(typeof fixture.requests[1]?.state.toolDescription, "string");
  } finally {
    await fixture.close();
  }
});
