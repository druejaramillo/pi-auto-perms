import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

test("trusted project rules can replace a global deterministic denial", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { read: "deny" } },
    project: { permission: { read: "allow" } },
  });
  try {
    await writeFile(join(fixture.cwd, "public.txt"), "project override");
    const result = await fixture.run("read", { path: "public.txt" });
    assert.equal(result.isError, false);
    assert.match(permissionResultText(result), /project override/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("trusted project catch-all can override even a global protected-path denial", async () => {
  const fixture = await createPermissionSession({
    project: { permission: { path: { "*": "allow" } } },
  });
  try {
    await writeFile(join(fixture.cwd, "fixture.env"), "only synthetic fixture data");
    const result = await fixture.run("read", { path: "fixture.env" });
    assert.equal(result.isError, false);
    assert.match(permissionResultText(result), /synthetic fixture data/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("trusted project boundary policy can replace a global boundary deny", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { external_directory: "deny" } },
    project: { permission: { external_directory: "allow" } },
  });
  try {
    const external = join(fixture.agentDir, "external.txt");
    await writeFile(external, "explicitly permitted external read");
    const result = await fixture.run("read", { path: external });
    assert.equal(result.isError, false);
    assert.match(permissionResultText(result), /explicitly permitted external read/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("an untrusted project cannot weaken the global policy", async () => {
  const fixture = await createPermissionSession({
    trusted: false,
    global: { permission: { read: "deny" } },
    project: { permission: { read: "allow" } },
  });
  try {
    await writeFile(join(fixture.cwd, "public.txt"), "not exposed");
    const result = await fixture.run("read", { path: "public.txt" });
    assert.equal(result.isError, true);
    assert.doesNotMatch(permissionResultText(result), /not exposed/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("revoking project trust stops previously cached project allowances", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { read: "deny" } },
    project: { permission: { read: "allow" } },
  });
  try {
    await writeFile(join(fixture.cwd, "trust.txt"), "synthetic fixture");
    const allowed = await fixture.run("read", { path: "trust.txt" });
    assert.equal(allowed.isError, false);
    fixture.setProjectTrusted(false);
    const denied = await fixture.run("read", { path: "trust.txt" });
    assert.equal(denied.isError, true);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("project semantic rules replace every matching ID and add new IDs", async () => {
  const fixture = await createPermissionSession({
    global: { rules: [{ id: "gate", effect: "deny", when: "Global restriction." }] },
    project: {
      rules: [
        { id: "gate", effect: "allow", when: "Project approval." },
        { id: "additional", effect: "deny", when: "Additional project restriction." },
      ],
    },
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run("write", { path: "rules.txt", content: "merged" });
    assert.equal(result.isError, false);
    const rules = JSON.stringify(fixture.requests[0]?.state.rules);
    assert.match(rules, /"id":"gate","effect":"allow","when":"Project approval\."/);
    assert.match(rules, /"id":"additional","effect":"deny"/);
    assert.match(rules, /"id":"private-data"/);
    assert.doesNotMatch(rules, /Global restriction/);
    assert.equal(await readFile(join(fixture.cwd, "rules.txt"), "utf8"), "merged");
  } finally {
    await fixture.close();
  }
});

for (const invalid of [
  { minAllowProbability: 0 },
  { failOpen: true },
  {
    rules: [
      { id: "same", effect: "allow", when: "one" },
      { id: "same", effect: "deny", when: "two" },
    ],
  },
]) {
  test(`invalid global configuration blocks rather than falling back: ${JSON.stringify(invalid)}`, async () => {
    const fixture = await createPermissionSession({ global: invalid });
    try {
      const result = await fixture.run("write", { path: "invalid.txt", content: "blocked" });
      assert.equal(result.isError, true);
      assert.match(permissionResultText(result), /Configuration/);
      assert.equal(fixture.requests.length, 0);
      await assert.rejects(readFile(join(fixture.cwd, "invalid.txt")), { code: "ENOENT" });
    } finally {
      await fixture.close();
    }
  });
}

test("project policy may override rules, but cannot redirect the reviewer or lower its threshold", async () => {
  const fixture = await createPermissionSession({ project: { minAllowProbability: 0.51 } });
  try {
    const result = await fixture.run("write", { path: "threshold.txt", content: "blocked" });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Configuration/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("configuration changes take effect only on an explicit policy reload", async () => {
  const fixture = await createPermissionSession({ global: { permission: { write: "allow" } } });
  try {
    await writeFile(fixture.globalPath, JSON.stringify({ permission: { write: "deny" } }));
    const beforeReload = await fixture.run("write", {
      path: "snapshot.txt",
      content: "old snapshot",
    });
    assert.equal(beforeReload.isError, false);
    await fixture.session.prompt("/auto-perms reload");
    const afterReload = await fixture.run("write", {
      path: "snapshot.txt",
      content: "must not replace",
    });
    assert.equal(afterReload.isError, true);
    assert.equal(await readFile(join(fixture.cwd, "snapshot.txt"), "utf8"), "old snapshot");
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("an in-flight approval cannot execute after the user reloads a denying policy", {
  timeout: 3000,
}, async () => {
  let entered: () => void = () => {};
  const reviewing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: ((value: ClassifierResult) => void) | undefined;
  const fixture = await createPermissionSession({
    classify: () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const execution = fixture.run("write", { path: "stale.txt", content: "must not be written" });
    await reviewing;
    await writeFile(fixture.globalPath, JSON.stringify({ permission: { write: "deny" } }));
    await fixture.session.prompt("/auto-perms reload");
    const context = fixture.requests[0];
    assert.ok(context);
    release?.(permissionAnswer(context));
    const result = await execution;
    assert.equal(result.isError, true);
    await assert.rejects(readFile(join(fixture.cwd, "stale.txt")), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});
