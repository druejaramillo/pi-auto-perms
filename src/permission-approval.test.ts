import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

for (const approval of ["yes", "yes you can use all git commands"]) {
  test(`written approval '${approval}' includes the agent's question and exact retry`, async () => {
    const question = "May I retry git --version with your authorization?";
    const fixture = await createPermissionSession({
      assistantReply: question,
      classify: async (context) => {
        const authorization = context.state.authorizationContext;
        return authorization &&
          typeof authorization === "object" &&
          "latestUserMessage" in authorization &&
          "assistantMessageBeforeLatestUser" in authorization &&
          "matchesPreviousBlockedAction" in authorization &&
          authorization.latestUserMessage === approval &&
          authorization.assistantMessageBeforeLatestUser === question &&
          authorization.matchesPreviousBlockedAction === true
          ? permissionAnswer(context)
          : permissionAnswer(context, 0.71, 0.01, 0.28, "allow", "allowed");
      },
    });
    try {
      const initial = await fixture.run(
        "bash",
        { command: "git --version" },
        "Check Git's version.",
      );
      assert.equal(initial.isError, true);
      const retry = await fixture.run("bash", { command: "git --version" }, approval);
      assert.equal(retry.isError, false);
      assert.match(permissionResultText(retry), /git version/);
      assert.equal(fixture.requests.length, 2);
      assert.deepEqual(fixture.requests[1]?.state.authorizationContext, {
        latestUserMessage: approval,
        assistantMessageBeforeLatestUser: question,
        matchesPreviousBlockedAction: true,
      });
      assert.equal(fixture.requests[1]?.state.deterministicDecision, "review");
    } finally {
      await fixture.close();
    }
  });
}

async function approvePermissionAndWait(
  fixture: Awaited<ReturnType<typeof createPermissionSession>>,
): Promise<void> {
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<void>((resolve, reject) => {
    unsubscribe = fixture.session.subscribe((event) => {
      if (event.type === "agent_settled") resolve();
    });
    timer = setTimeout(() => reject(new Error("Manual approval did not resume the agent")), 1500);
  });
  try {
    await fixture.session.prompt("/auto-perms approve");
    await settled;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

test("manual approval overrides a reviewer denial for one exact action and resumes the agent", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    const denied = await fixture.run("write", {
      path: "override.txt",
      content: "explicit override",
    });
    assert.equal(denied.isError, true);
    await assert.rejects(readFile(join(fixture.cwd, "override.txt")), { code: "ENOENT" });
    await approvePermissionAndWait(fixture);
    assert.equal(await readFile(join(fixture.cwd, "override.txt"), "utf8"), "explicit override");
    assert.equal(fixture.requests.length, 1);
    const decisions = fixture.session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === "auto-perms-decision" ? [entry.data] : [],
      );
    assert.deepEqual(decisions.at(-1), {
      tool: "write",
      toolCallId: "fixture-call-0",
      action: "allow",
      source: "manual-approval",
    });
    const deniedAgain = await fixture.run("write", {
      path: "override.txt",
      content: "not granted",
    });
    assert.equal(deniedAgain.isError, true);
    assert.equal(await readFile(join(fixture.cwd, "override.txt"), "utf8"), "explicit override");
    assert.equal(fixture.requests.length, 2);
  } finally {
    await fixture.close();
  }
});

test("written approval never fabricates a high-probability verdict when review stays uncertain", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.48, 0.03, 0.49, "ask", "needs_approval"),
  });
  try {
    await fixture.run("write", { path: "uncertain.txt", content: "blocked" });
    const retry = await fixture.run(
      "write",
      { path: "uncertain.txt", content: "blocked" },
      "Yes, write uncertain.txt with that content.",
    );
    assert.equal(retry.isError, true);
    assert.match(permissionResultText(retry), /selected ask, probability 0.4900/);
    assert.match(permissionResultText(retry), /Recent user messages were included/);
    await assert.rejects(readFile(join(fixture.cwd, "uncertain.txt")), { code: "ENOENT" });
    assert.equal(fixture.requests.length, 2);
  } finally {
    await fixture.close();
  }
});

test("manual approval matches identical arguments with reordered object keys", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    await fixture.run("write", { path: "ordered.txt", content: "same invocation" });
    fixture.setNextAction("write", { content: "same invocation", path: "ordered.txt" });
    await approvePermissionAndWait(fixture);
    assert.equal(await readFile(join(fixture.cwd, "ordered.txt"), "utf8"), "same invocation");
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("manual approval cannot authorize changed arguments", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    await fixture.run("write", { path: "original.txt", content: "original invocation" });
    fixture.setNextAction("write", { path: "changed.txt", content: "different invocation" });
    await approvePermissionAndWait(fixture);
    await assert.rejects(readFile(join(fixture.cwd, "original.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(fixture.cwd, "changed.txt")), { code: "ENOENT" });
    assert.equal(fixture.requests.length, 2);
    const outcome = fixture.session.messages
      .filter((message) => message.role === "toolResult")
      .at(-1);
    assert.equal(outcome?.isError, true);
  } finally {
    await fixture.close();
  }
});

test("manual approval is consumed once even if the agent repeats the identical invocation", async () => {
  const fixture = await createPermissionSession({
    attemptsPerTurn: 2,
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    await fixture.run("write", { path: "once.txt", content: "one override" });
    await approvePermissionAndWait(fixture);
    assert.equal(await readFile(join(fixture.cwd, "once.txt"), "utf8"), "one override");
    const results = fixture.session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.at(-2)?.isError, false);
    assert.equal(results.at(-1)?.isError, true);
    assert.equal(fixture.requests.length, 3);
  } finally {
    await fixture.close();
  }
});

for (const invalidate of ["reload", "trust", "input"] as const) {
  test(`${invalidate} changes invalidate the last reviewer-blocked override target`, async () => {
    const fixture = await createPermissionSession({
      classify: async (context) =>
        permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
    });
    try {
      await fixture.run("write", { path: "stale-override.txt", content: "blocked" });
      if (invalidate === "reload") await fixture.session.prompt("/auto-perms reload");
      if (invalidate === "trust") fixture.setProjectTrusted(false);
      if (invalidate === "input") {
        await fixture.run("bash", { command: "pwd" }, "Do not retry the previous write.");
      }
      await fixture.session.prompt("/auto-perms approve");
      await assert.rejects(readFile(join(fixture.cwd, "stale-override.txt")), { code: "ENOENT" });
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.session.isStreaming, false);
    } finally {
      await fixture.close();
    }
  });
}

test("manual approval cannot override a deterministic path denial or approve an older action", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    await fixture.run("write", { path: "older.txt", content: "older block" });
    const denied = await fixture.run(
      "write",
      { path: ".env", content: "protected" },
      "Review this.",
      "extension",
    );
    assert.equal(denied.isError, true);
    await fixture.session.prompt("/auto-perms approve");
    await assert.rejects(readFile(join(fixture.cwd, "older.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(fixture.cwd, ".env")), { code: "ENOENT" });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.session.isStreaming, false);
  } finally {
    await fixture.close();
  }
});

test("manual override retains credential-shaped retry evidence without logging arguments", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    const content = "Authorization: Bearer fixture-not-a-real-secret";
    const denied = await fixture.run("write", { path: "stored-locally.txt", content });
    assert.equal(denied.isError, true);
    assert.match(permissionResultText(denied), /Reviewer denied this action/);
    assert.equal(fixture.requests.length, 1);
    await assert.rejects(readFile(join(fixture.cwd, "stored-locally.txt")), { code: "ENOENT" });
    const retried = await fixture.run(
      "write",
      { path: "stored-locally.txt", content },
      "Yes, write that exact synthetic test fixture.",
    );
    assert.equal(retried.isError, true);
    assert.match(permissionResultText(retried), /Reviewer denied this action/);
    assert.deepEqual(fixture.requests[1]?.state.previousBlockedAction, {
      tool: "write",
      input: { path: "stored-locally.txt", content },
    });
    await assert.rejects(readFile(join(fixture.cwd, "stored-locally.txt")), { code: "ENOENT" });
    await approvePermissionAndWait(fixture);
    assert.equal(await readFile(join(fixture.cwd, "stored-locally.txt"), "utf8"), content);
    assert.equal(fixture.requests.length, 2);
    const decisions = fixture.session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === "auto-perms-decision" ? [entry.data] : [],
      );
    assert.doesNotMatch(JSON.stringify(decisions), /Bearer|fixture-not-a-real-secret/);
  } finally {
    await fixture.close();
  }
});

test("manual approval rechecks path denials if the target becomes a protected symlink", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    await writeFile(join(fixture.cwd, ".env"), "unchanged protected file");
    await fixture.run("write", { path: "alias.txt", content: "must not reach .env" });
    await symlink(join(fixture.cwd, ".env"), join(fixture.cwd, "alias.txt"));
    await approvePermissionAndWait(fixture);
    assert.equal(await readFile(join(fixture.cwd, ".env"), "utf8"), "unchanged protected file");
    assert.equal(fixture.requests.length, 1);
    const outcome = fixture.session.messages
      .filter((message) => message.role === "toolResult")
      .at(-1);
    assert.equal(outcome?.isError, true);
  } finally {
    await fixture.close();
  }
});

test("manual approval cannot authorize another tool or preserve the grant after a mismatch", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    await fixture.run("write", { path: "original-tool.txt", content: "blocked" });
    fixture.setNextAction("bash", { command: "git --version" });
    await approvePermissionAndWait(fixture);
    assert.equal(fixture.requests.length, 2);
    const retry = await fixture.run(
      "write",
      { path: "original-tool.txt", content: "blocked" },
      "Retry the original invocation.",
      "extension",
    );
    assert.equal(retry.isError, true);
    await assert.rejects(readFile(join(fixture.cwd, "original-tool.txt")), { code: "ENOENT" });
    assert.equal(fixture.requests.length, 3);
  } finally {
    await fixture.close();
  }
});

test("an unused manual override expires when its retry turn settles", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  try {
    await fixture.run("write", { path: "unused.txt", content: "blocked" });
    fixture.setNextAction("unknown_tool_without_a_permission_hook", {});
    await approvePermissionAndWait(fixture);
    const retry = await fixture.run(
      "write",
      { path: "unused.txt", content: "blocked" },
      "Retry the original invocation.",
      "extension",
    );
    assert.equal(retry.isError, true);
    await assert.rejects(readFile(join(fixture.cwd, "unused.txt")), { code: "ENOENT" });
    assert.equal(fixture.requests.length, 2);
  } finally {
    await fixture.close();
  }
});
