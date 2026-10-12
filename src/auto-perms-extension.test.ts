import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createPermissionSession, permissionAnswer } from "../test/pi-session-fixture.ts";

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

test("a deterministic denial prevents a real Pi read without calling a reviewer", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { read: { "*": "allow", "secret.txt": "deny" } } },
  });
  try {
    await writeFile(join(fixture.cwd, "secret.txt"), "private fixture content");
    const result = await fixture.run("read", { path: "secret.txt" });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /pi-auto-perms.*denied/i);
    assert.doesNotMatch(resultText(result), /private fixture content/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a valid high-probability review lets Pi execute an otherwise asked write", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run(
      "write",
      { path: "approved.txt", content: "approved content" },
      "Create approved.txt in this project.",
    );
    assert.equal(result.isError, false);
    assert.equal(await readFile(join(fixture.cwd, "approved.txt"), "utf8"), "approved content");
    assert.equal(fixture.reviewers[0], "typesafe/jev-latest");
    assert.deepEqual(fixture.requests[0]?.state.userMessages, [
      "Create approved.txt in this project.",
    ]);
  } finally {
    await fixture.close();
  }
});
