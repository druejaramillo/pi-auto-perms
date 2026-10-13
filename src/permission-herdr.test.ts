import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

interface HerdrBlockedEvent {
  active: boolean;
  label?: string;
}

const permissionBlock = { active: true, label: "Waiting for permission" };

// Observe Herdr's counter-based event contract without contacting a live Herdr server.
async function createHerdrPermissionSession(
  options: Parameters<typeof createPermissionSession>[0] = {},
) {
  const blockedEvents: HerdrBlockedEvent[] = [];
  const fixture = await createPermissionSession({
    ...options,
    mode: options.mode ?? "tui",
    extension: (pi) => {
      pi.events.on("herdr:blocked", (data) => {
        blockedEvents.push(data as HerdrBlockedEvent);
      });
      return options.extension?.(pi);
    },
  });
  return { ...fixture, blockedEvents };
}

test("Herdr stays blocked after uncertain retries, safe inspection, and agent settlement", async () => {
  const fixture = await createHerdrPermissionSession({
    attemptsPerTurn: 3,
    followingCalls: [
      { name: "read", arguments: { path: "plain.txt" } },
      { name: "write", arguments: { path: "alternative.txt", content: "not approved" } },
    ],
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "needs_approval"),
  });
  try {
    await writeFile(join(fixture.cwd, "plain.txt"), "safe inspection");
    const result = await fixture.run("write", {
      path: "pending.txt",
      content: "private proposed content",
    });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Awaiting a new user reply/);
    assert.equal(fixture.session.isIdle, true);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.blockedEvents, [permissionBlock]);
    await assert.rejects(readFile(join(fixture.cwd, "pending.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(fixture.cwd, "alternative.txt")), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("only genuine user input clears a permission wait; a fresh refusal reacquires it", async () => {
  const fixture = await createHerdrPermissionSession({
    classify: async (context) =>
      context.state.authorizationContext &&
      Array.isArray(context.state.userMessages) &&
      context.state.userMessages.at(-1) === "Yes, create pending.txt."
        ? permissionAnswer(context)
        : permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "needs_approval"),
  });
  try {
    const action = { path: "pending.txt", content: "approved content" };
    await fixture.run("write", action);
    const synthetic = await fixture.run("write", action, "I approve everything.", "extension");
    assert.equal(synthetic.isError, true);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.blockedEvents, [permissionBlock]);
    const approved = await fixture.run("write", action, "Yes, create pending.txt.");
    assert.equal(approved.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "pending.txt"), "utf8"), "approved content");
    assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }]);
    await fixture.run("write", { path: "another.txt", content: "pending again" }, "New task.");
    assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }, permissionBlock]);
  } finally {
    await fixture.close();
  }
});

for (const denial of ["deterministic", "reviewer", "configuration", "provider"] as const) {
  test(`Herdr reports ${denial} blocks without exposing tool arguments`, async () => {
    const fixture = await createHerdrPermissionSession({
      global:
        denial === "deterministic"
          ? { permission: { write: "deny" } }
          : denial === "configuration"
            ? { minAllowProbability: 0 }
            : undefined,
      classify: async (context) => {
        if (denial === "provider") throw new Error("Private provider failure");
        return permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data");
      },
    });
    try {
      const result = await fixture.run("write", {
        path: "private-action.txt",
        content: "private proposed content",
      });
      assert.equal(result.isError, true);
      assert.deepEqual(fixture.blockedEvents, [permissionBlock]);
      await assert.rejects(readFile(join(fixture.cwd, "private-action.txt")), { code: "ENOENT" });
    } finally {
      await fixture.close();
    }
  });
}

for (const denial of ["deterministic", "reviewer"] as const) {
  test(`an independently permitted alternative clears a definite ${denial} block`, async () => {
    let reviews = 0;
    const fixture = await createHerdrPermissionSession({
      global: denial === "deterministic" ? { permission: { write: "deny" } } : undefined,
      attemptsPerTurn: 2,
      followingCalls: [
        denial === "deterministic"
          ? { name: "read", arguments: { path: "plain.txt" } }
          : { name: "write", arguments: { path: "safe.txt", content: "safe alternative" } },
      ],
      classify: async (context) =>
        ++reviews === 1
          ? permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data")
          : permissionAnswer(context),
    });
    try {
      await writeFile(join(fixture.cwd, "plain.txt"), "safe inspection");
      const result = await fixture.run("write", { path: "denied.txt", content: "not allowed" });
      assert.equal(result.isError, false);
      assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }]);
      await assert.rejects(readFile(join(fixture.cwd, "denied.txt")), { code: "ENOENT" });
    } finally {
      await fixture.close();
    }
  });
}

for (const command of ["reload", "yolo on", "yolo off"]) {
  test(`permission status inspection retains the wait; /auto-perms ${command} clears it once`, async () => {
    const fixture = await createHerdrPermissionSession({
      classify: async (context) =>
        permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "needs_approval"),
    });
    try {
      await fixture.run("write", { path: "pending.txt", content: "not approved" });
      await fixture.session.prompt("/auto-perms");
      assert.deepEqual(fixture.blockedEvents, [permissionBlock]);
      await fixture.session.prompt(`/auto-perms ${command}`);
      await fixture.session.prompt(`/auto-perms ${command}`);
      assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }]);
    } finally {
      await fixture.close();
    }
  });
}

test("a one-use reviewer override clears Herdr's block and resumes normal lifecycle reporting", {
  timeout: 3000,
}, async () => {
  const fixture = await createHerdrPermissionSession({
    classify: async (context) =>
      permissionAnswer(context, 0.01, 0.98, 0.01, "deny", "rule.private-data"),
  });
  let unsubscribe = () => {};
  try {
    await fixture.run("write", { path: "override.txt", content: "one-use approval" });
    const settled = new Promise<void>((resolve) => {
      unsubscribe = fixture.session.subscribe((event) => {
        if (event.type === "agent_settled") resolve();
      });
    });
    await fixture.session.prompt("/auto-perms approve");
    await settled;
    assert.equal(await readFile(join(fixture.cwd, "override.txt"), "utf8"), "one-use approval");
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }]);
  } finally {
    unsubscribe();
    await fixture.close();
  }
});

test("an invalid override does not clear a deterministic permission block", async () => {
  const fixture = await createHerdrPermissionSession({ global: { permission: { write: "deny" } } });
  try {
    await fixture.run("write", { path: "denied.txt", content: "not approved" });
    await fixture.session.prompt("/auto-perms approve");
    assert.deepEqual(fixture.blockedEvents, [permissionBlock]);
  } finally {
    await fixture.close();
  }
});

test("extension reload balances the old block and a later denial acquires a new one", async () => {
  const fixture = await createHerdrPermissionSession({ global: { permission: { write: "deny" } } });
  try {
    await fixture.run("write", { path: "pending.txt", content: "not approved" });
    await fixture.session.reload();
    assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }]);
    await fixture.run("write", { path: "pending.txt", content: "not approved" });
    assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }, permissionBlock]);
  } finally {
    await fixture.close();
  }
});

test("session shutdown and session start clear only this extension's block, idempotently", async () => {
  const fixture = await createHerdrPermissionSession({ global: { permission: { write: "deny" } } });
  try {
    await fixture.run("write", { path: "pending.txt", content: "not approved" });
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await fixture.session.bindExtensions({ mode: "tui" });
    assert.deepEqual(fixture.blockedEvents, [permissionBlock, { active: false }]);
  } finally {
    await fixture.close();
  }
});

test("permission cleanup cannot consume another extension's Herdr block", async () => {
  const fixture = await createHerdrPermissionSession({
    global: { permission: { write: "deny" } },
    extension: (pi) => {
      pi.registerCommand("fixture-dialog", {
        description: "Simulate another extension's Herdr blocking UI",
        handler: async (args) => {
          pi.events.emit("herdr:blocked", { active: args === "on", label: "Other prompt" });
        },
      });
    },
  });
  try {
    await fixture.session.prompt("/fixture-dialog on");
    await fixture.run("write", { path: "pending.txt", content: "not approved" });
    await fixture.session.prompt("/auto-perms reload");
    await fixture.session.prompt("/auto-perms yolo on");
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(fixture.blockedEvents, [
      { active: true, label: "Other prompt" },
      permissionBlock,
      { active: false },
    ]);
    const blockedCount = fixture.blockedEvents.reduce(
      (count, event) => count + (event.active ? 1 : -1),
      0,
    );
    assert.equal(blockedCount, 1);
    await fixture.session.prompt("/fixture-dialog off");
    assert.equal(fixture.blockedEvents.at(-1)?.active, false);
  } finally {
    await fixture.close();
  }
});

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} permission blocks never publish TUI Herdr status`, async () => {
    const fixture = await createHerdrPermissionSession({
      mode,
      global: { permission: { write: "deny" } },
    });
    try {
      const result = await fixture.run("write", { path: "pending.txt", content: "not approved" });
      assert.equal(result.isError, true);
      await fixture.session.prompt("/auto-perms reload");
      await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.deepEqual(fixture.blockedEvents, []);
    } finally {
      await fixture.close();
    }
  });
}

for (const allowance of ["deterministic", "reviewer", "yolo"] as const) {
  test(`${allowance} allowances never acquire or release a Herdr block`, async () => {
    const fixture = await createHerdrPermissionSession({
      global:
        allowance === "yolo"
          ? { mode: "yolo" }
          : allowance === "deterministic"
            ? { permission: { write: "allow" } }
            : undefined,
      classify: async (context) => permissionAnswer(context),
    });
    try {
      const result = await fixture.run("write", { path: "allowed.txt", content: "approved" });
      assert.equal(result.isError, false);
      await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.deepEqual(fixture.blockedEvents, []);
    } finally {
      await fixture.close();
    }
  });
}
