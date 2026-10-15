import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

for (const [expansion, expected] of [
  [`\${spec%%|*}`, "alpha"],
  [`\${spec%|*}`, "alpha|middle"],
  [`\${spec##*|}`, "report"],
  [`\${spec#*|}`, "middle|report"],
  [`"\${spec%%|*}"`, "alpha"],
] as const) {
  test(`Bash trim pattern ${expansion} reaches review unchanged before execution`, async () => {
    const fixture = await createPermissionSession({
      global: { permission: { bash: "allow" } },
      classify: async (context) => permissionAnswer(context),
    });
    try {
      const command = `spec='alpha|middle|report'; value=${expansion}; printf '%s' "$value"`;
      const result = await fixture.run("bash", { command });
      assert.equal(result.isError, false, permissionResultText(result));
      assert.equal(permissionResultText(result), expected);
      assert.equal(fixture.requests.length, 1);
      assert.deepEqual(fixture.requests[0]?.state.tool, { name: "bash", input: { command } });
    } finally {
      await fixture.close();
    }
  });
}

test("a compound PDF loop reaches review intact without executing PDF tools", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "unclear"),
  });
  try {
    const command = [
      "workdir=$(mktemp -d /tmp/ppm.XXXXXX)",
      " && printf 'Working directory: %s\\n' \"$workdir\"",
      " && for spec in 'income|Income PPM.pdf' 'industrial|Industrial PPM.pdf';",
      ` do name=\${spec%%|*}; file=\${spec#*|};`,
      " printf '\\n--- %s ---\\n' \"$name\";",
      ' pdfinfo "/home/example/Downloads/$file";',
      ' pdftotext -layout "/home/example/Downloads/$file" "$workdir/$name.txt" || exit; done',
    ].join("");
    const result = await fixture.run("bash", { command });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Review uncertain/);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.requests[0]?.state.tool, { name: "bash", input: { command } });
  } finally {
    await fixture.close();
  }
});

for (const separator of [";", "&&", "|"]) {
  test(`a denied command after a Bash trim pattern stays denied across ${separator}`, async () => {
    const fixture = await createPermissionSession({
      global: { permission: { bash: { "*": "ask", "rm *": "deny" } } },
      classify: async (context) => permissionAnswer(context),
    });
    try {
      await writeFile(join(fixture.cwd, "victim.txt"), "survives");
      const result = await fixture.run("bash", {
        command: `spec='alpha|report'; printf '%s' \${spec%%|*} ${separator} rm victim.txt`,
      });
      assert.equal(result.isError, true);
      assert.match(permissionResultText(result), /Denied by deterministic rule.*rm/);
      assert.equal(await readFile(join(fixture.cwd, "victim.txt"), "utf8"), "survives");
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

test("a protected path after a Bash trim pattern stays denied", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run("bash", {
      command: `printf '%s' \${spec%%|*} private.env`,
    });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Denied by deterministic rule.*path_/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("single-quoted trim-pattern text is not rewritten for deterministic matching", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { bash: { "*": "ask", "printf %s ${spec%%|*}": "deny" } } },
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run("bash", { command: `printf '%s' '\${spec%%|*}'` });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Denied by deterministic rule/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

for (const substitution of ["$(rm victim.txt)", "<(rm victim.txt)", ">(rm victim.txt)"]) {
  test(`executable ${substitution} inside a trim pattern still fails closed`, async () => {
    const fixture = await createPermissionSession({
      global: { permission: { bash: { "*": "ask", "rm *": "deny" } } },
      classify: async (context) => permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "unclear"),
    });
    try {
      await writeFile(join(fixture.cwd, "victim.txt"), "survives");
      const result = await fixture.run("bash", {
        command: `printf '%s' \${spec%%${substitution}|*}`,
      });
      assert.equal(result.isError, true);
      assert.match(permissionResultText(result), /Shell command parsing failed/);
      assert.equal(await readFile(join(fixture.cwd, "victim.txt"), "utf8"), "survives");
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

test("shell parse failures do not blame configuration or echo command arguments", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const result = await fixture.run("bash", {
      command: "printf '%s' ${fixture-private-parser-marker",
    });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Shell command parsing failed/);
    assert.doesNotMatch(
      permissionResultText(result),
      /configuration|reload|fixture-private-parser-marker/i,
    );
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});
