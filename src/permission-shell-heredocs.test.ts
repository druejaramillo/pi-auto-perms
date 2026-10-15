import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";
import { stripPermissionShellHeredocs } from "./permission-shell-heredocs.ts";

for (const [header, delimiter, indent] of [
  ["node --input-type=module <<'NODE'", "NODE", ""],
  ['node --input-type=module << "NODE"', "NODE", ""],
  ["node --input-type=module <<\\NODE", "NODE", ""],
  ["node --input-type=module <<N'ODE'", "NODE", ""],
  ["node --input-type=module <<-'NODE'", "NODE", "\t"],
  ["node --input-type=module 0<<'NODE'", "NODE", ""],
  ["node --input-type=module <<'SOURCE.env.JS'", "SOURCE.env.JS", ""],
  ["node --input-type=module <<'SOURCE CODE'", "SOURCE CODE", ""],
  ["node --input-type=module <<NODE", "NODE", ""],
  ["node --input-type=module <<''", "", ""],
  ["cd . && node --input-type=module <<'NODE'", "NODE", ""],
  ["cat <<'NODE' | node --input-type=module", "NODE", ""],
] as const) {
  test(`heredoc stdin is reviewed and executes unchanged: ${header}`, async () => {
    const fixture = await createPermissionSession({
      classify: async (context) => permissionAnswer(context),
    });
    try {
      const command = [
        header,
        `${indent}import assert from 'node:assert/strict';`,
        `${indent}assert.equal(typeof (process.env.HERDR_BIN_PATH ?? 'herdr'), 'string');`,
        `${indent}console.log('heredoc reviewed');`,
        `${indent}${delimiter}`,
        "",
      ].join("\n");
      const result = await fixture.run("bash", { command });
      assert.equal(result.isError, false, permissionResultText(result));
      assert.equal(permissionResultText(result), "heredoc reviewed\n");
      assert.equal(fixture.requests.length, 1);
      assert.deepEqual(fixture.requests[0]?.state.tool, { name: "bash", input: { command } });
    } finally {
      await fixture.close();
    }
  });
}

test("the reported Herdr heredoc reaches review intact without contacting Herdr", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context, 0.01, 0.01, 0.98, "ask", "unclear"),
  });
  try {
    const command = [
      `cd '${fixture.cwd}' && node --input-type=module <<'NODE'`,
      "import assert from 'node:assert/strict';",
      "import { execFile } from 'node:child_process';",
      "import { promisify } from 'node:util';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "import { callHerdrApi } from './herdr-json-api.ts';",
      "import { collectPlannotatorRenderers } from './plannotator-herdr-protocol.ts';",
      "const exec = promisify(execFile);",
      "const relay = { socket: '/tmp/fixture-herdr-relay.sock' };",
      "const status = await callHerdrApi(relay, 'status');",
      "assert.equal(status.protocol, 2);",
      "assert.match(status.renderer.id, /^[a-f0-9]{20}$/);",
      "const profiles = JSON.parse((await exec(process.env.HERDR_BIN_PATH ?? 'herdr', ['machine', 'list', '--json'], { timeout: 5000 })).stdout).filter(profile => profile.enabled);",
      "const sources = [{ label: 'Local', endpoint: { socket: process.env.HERDR_SOCKET_PATH } }, ...profiles.map(machine => ({ label: machine.label, endpoint: { machine } }))];",
      "const results = await Promise.all(sources.map(async source => {",
      "  const deadline = Date.now() + 15000;",
      "  let panes;",
      "  let renderers;",
      "  do {",
      "    ({ panes } = await callHerdrApi(source.endpoint, 'pane.list'));",
      "    renderers = collectPlannotatorRenderers(panes);",
      "    if (renderers.some(renderer => renderer.id === status.renderer.id)) break;",
      "    await delay(1000);",
      "  } while (Date.now() < deadline);",
      `  assert.ok(renderers.some(renderer => renderer.id === status.renderer.id), \`\${source.label}: renderer missing\`);`,
      "  return { host: source.label, panes: panes.length, renderers };",
      "}));",
      "console.log(JSON.stringify({ status: await callHerdrApi(relay, 'status'), sources: results }, null, 2));",
      "NODE",
    ].join("\n");
    const result = await fixture.run("bash", { command });
    assert.equal(result.isError, true);
    assert.match(permissionResultText(result), /Review uncertain/);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.requests[0]?.state.tool, { name: "bash", input: { command } });
  } finally {
    await fixture.close();
  }
});

test("quoted heredoc contents are opaque data even when they resemble shell syntax", async () => {
  const fixture = await createPermissionSession({
    global: { permission: { bash: { "*": "allow", "rm *": "deny" } } },
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const body = "process.env.HERDR_BIN_PATH\nrm victim.txt\n$(rm victim.txt)\n`unclosed ' \"";
    const command = `cat <<'DATA'\n${body}\nDATA`;
    const result = await fixture.run("bash", { command });
    assert.equal(result.isError, false, permissionResultText(result));
    assert.equal(permissionResultText(result), `${body}\n`);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.requests[0]?.state.tool, { name: "bash", input: { command } });
  } finally {
    await fixture.close();
  }
});

test("multiple heredocs are consumed in declaration order without treating their bodies as paths", async () => {
  const fixture = await createPermissionSession({
    classify: async (context) => permissionAnswer(context),
  });
  try {
    const command = [
      "cat <<'FIRST.env.JS' <<-'SECOND'",
      "process.env.HERDR_BIN_PATH",
      "FIRST.env.JS",
      "\tprocess.env.HERDR_SOCKET_PATH",
      "\tSECOND",
    ].join("\n");
    const result = await fixture.run("bash", { command });
    assert.equal(result.isError, false, permissionResultText(result));
    assert.equal(permissionResultText(result), "process.env.HERDR_SOCKET_PATH\n");
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.requests[0]?.state.tool, { name: "bash", input: { command } });
  } finally {
    await fixture.close();
  }
});

for (const command of [
  "cat <<'DATA' private.env\nliteral data\nDATA",
  "cat <<'DATA' > private.env\nliteral data\nDATA",
  "cat > private.env <<'DATA'\nliteral data\nDATA",
  "cat <<'DATA'\nliteral data\nDATA\ncat private.env",
  "cat <<'DATA' && cat private.env\nliteral data\nDATA",
  "cat <<'DATA' # header comment\nliteral data\nDATA\ncat private.env",
  "cat <<'DATA'\nliteral data\nDATA\n# trailing comment\ncat private.env",
]) {
  test(`heredoc boundaries preserve protected-path checks: ${command.split("\n")[0]}`, async () => {
    const fixture = await createPermissionSession({
      classify: async (context) => permissionAnswer(context),
    });
    try {
      const result = await fixture.run("bash", { command });
      assert.equal(result.isError, true);
      assert.match(permissionResultText(result), /Denied by deterministic rule.*path_/);
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

for (const command of [
  "cat <<'DATA'\nliteral data\nDATA\nrm victim.txt",
  "cat <<'DATA' && rm victim.txt\nliteral data\nDATA",
  "rm victim.txt && cat <<'DATA'\nliteral data\nDATA",
  "cat <<'DATA' # header comment\nliteral data\nDATA\nrm victim.txt",
  "printf '%s' \"<<'DATA'\"\nrm victim.txt\nDATA",
  "# cat <<'DATA'\nrm victim.txt\nDATA",
  "printf '%s' \\<\\<DATA\nrm victim.txt\nDATA",
  "printf '%s' ordinary\nrm victim.txt",
]) {
  test(`heredoc scanning never hides a denied shell command: ${command.split("\n")[0]}`, async () => {
    const fixture = await createPermissionSession({
      global: { permission: { bash: { "*": "ask", "rm *": "deny" } } },
      classify: async (context) => permissionAnswer(context),
    });
    try {
      await writeFile(join(fixture.cwd, "victim.txt"), "survives");
      const result = await fixture.run("bash", { command });
      assert.equal(result.isError, true);
      assert.match(permissionResultText(result), /Denied by deterministic rule.*rm/);
      assert.equal(await readFile(join(fixture.cwd, "victim.txt"), "utf8"), "survives");
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

for (const command of [
  "cat <<DATA\n$(rm victim.txt)\nDATA",
  "cat <<DATA\n`rm victim.txt`\nDATA",
  "cat <<DATA\n$HOME\nDATA",
  "cat <<DATA\nDA\\\nTA\nrm victim.txt\nDATA",
  "cat <<'DATA'\nunterminated body",
  "cat <<'DATA'\nbody\nDATA ",
  "cat <<'DATA'",
  "cat <<$'DATA'\nbody\nDATA",
]) {
  test(`ambiguous or expanding heredocs fail closed: ${JSON.stringify(command)}`, async () => {
    const fixture = await createPermissionSession({
      global: { permission: { bash: "allow" } },
      classify: async (context) => permissionAnswer(context),
    });
    try {
      await writeFile(join(fixture.cwd, "victim.txt"), "survives");
      const result = await fixture.run("bash", { command });
      assert.equal(result.isError, true);
      assert.match(permissionResultText(result), /Shell command parsing failed/);
      assert.doesNotMatch(permissionResultText(result), /configuration|reload|victim/i);
      assert.equal(await readFile(join(fixture.cwd, "victim.txt"), "utf8"), "survives");
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

test("heredoc descriptor removal preserves numeric filename arguments", () => {
  for (const [header, expected] of [
    ["cat 3<<'DATA'", "cat ;\n"],
    ["cat '3'<<'DATA'", "cat '3';\n"],
    ["cat name\u00a03<<'DATA'", "cat name\u00a03;\n"],
  ]) {
    assert.equal(stripPermissionShellHeredocs(`${header}\nbody\nDATA`), expected);
  }
});

for (const command of [
  "echo $((1 << 2))",
  "((1 << 2))\nrm victim.txt\n2",
  "[[ a << b ]]\nrm victim.txt\nb",
  "echo `printf '<<DATA'`",
  "printf '%s' $'<<DATA'",
  'printf "%s" "$(printf \'<<DATA\')"',
]) {
  test(`nested shell syntax is never mistaken for a removable heredoc: ${command}`, () => {
    assert.equal(stripPermissionShellHeredocs(command), command);
  });
}
