import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createPermissionSession,
  permissionAnswer,
  permissionResultText,
} from "../test/pi-session-fixture.ts";

for (const tool of ["write", "edit"] as const) {
  for (const question of ["permission", "reason"] as const) {
    for (const otherProbability of [0.01, 0.03]) {
      test(`${tool} accepts ${question} probabilities totaling ${0.98 + otherProbability}`, async () => {
        const fixture = await createPermissionSession({
          classify: async (context) => {
            const result = permissionAnswer(context);
            const answer = result.answers[question];
            assert.ok(answer?.type === "choice");
            const other = Object.keys(answer.probabilities).find((key) => key !== answer.choice);
            answer.probabilities = Object.fromEntries(
              Object.keys(answer.probabilities).map((key) => [
                key,
                key === answer.choice ? 0.98 : key === other ? otherProbability : 0,
              ]),
            );
            return result;
          },
        });
        try {
          const path = join(fixture.cwd, "rounding.txt");
          if (tool === "edit") await writeFile(path, "before");
          const result = await fixture.run(
            tool,
            tool === "write"
              ? { path: "rounding.txt", content: "after" }
              : { path: "rounding.txt", edits: [{ oldText: "before", newText: "after" }] },
          );
          assert.equal(result.isError, false, permissionResultText(result));
          assert.equal(await readFile(path, "utf8"), "after");
        } finally {
          await fixture.close();
        }
      });
    }
  }
}

for (const choice of ["allowed", "rule.private-data"]) {
  test(`a one-point reason winner mismatch preserves the selected ${choice} label`, async () => {
    const fixture = await createPermissionSession({
      classify: async (context) => {
        const result = permissionAnswer(context, 0.98, 0.01, 0.01, "allow", choice);
        const reason = result.answers.reason;
        assert.ok(reason?.type === "choice");
        const other = choice === "allowed" ? "rule.private-data" : "allowed";
        reason.probabilities = Object.fromEntries(
          Object.keys(reason.probabilities).map((key) => [
            key,
            key === choice ? 0.49 : key === other ? 0.5 : key === "unclear" ? 0.01 : 0,
          ]),
        );
        return result;
      },
    });
    try {
      const result = await fixture.run("write", { path: "winner.txt", content: "after" });
      if (choice === "allowed") {
        assert.equal(result.isError, false, permissionResultText(result));
        assert.equal(await readFile(join(fixture.cwd, "winner.txt"), "utf8"), "after");
      } else {
        assert.equal(result.isError, true);
        assert.match(permissionResultText(result), /Reviewer returned conflicting decisions/);
        await assert.rejects(readFile(join(fixture.cwd, "winner.txt")), { code: "ENOENT" });
      }
    } finally {
      await fixture.close();
    }
  });
}

for (const choice of ["allow", "deny"] as const) {
  test(`a one-point permission winner mismatch keeps a low-probability ${choice} uncertain`, async () => {
    const fixture = await createPermissionSession({
      classify: async (context) =>
        permissionAnswer(
          context,
          choice === "allow" ? 0.49 : 0.5,
          choice === "deny" ? 0.49 : 0.5,
          0.01,
          choice,
          choice === "allow" ? "allowed" : "rule.private-data",
        ),
    });
    try {
      const result = await fixture.run("write", { path: "uncertain.txt", content: "blocked" });
      assert.equal(result.isError, true);
      assert.match(permissionResultText(result), /Review uncertain or awaiting authorization/);
      assert.ok(permissionResultText(result).includes(`selected ${choice}, probability 0.4900`));
      await assert.rejects(readFile(join(fixture.cwd, "uncertain.txt")), { code: "ENOENT" });
    } finally {
      await fixture.close();
    }
  });
}

for (const [allow, deny, ask, permitted] of [
  [0.949, 0.02, 0.021, false],
  [0.95, 0.03, 0.03, true],
] as const) {
  test(`rounded totals do not renormalize the allow probability ${allow} at threshold 0.95`, async () => {
    const fixture = await createPermissionSession({
      classify: async (context) => permissionAnswer(context, allow, deny, ask),
    });
    try {
      const result = await fixture.run("write", { path: "threshold.txt", content: "after" });
      assert.equal(result.isError, !permitted, permissionResultText(result));
      if (permitted) {
        assert.equal(await readFile(join(fixture.cwd, "threshold.txt"), "utf8"), "after");
      } else {
        assert.match(permissionResultText(result), /selected allow, probability 0.9490/);
        await assert.rejects(readFile(join(fixture.cwd, "threshold.txt")), { code: "ENOENT" });
      }
    } finally {
      await fixture.close();
    }
  });
}

for (const question of ["permission", "reason"] as const) {
  for (const failure of [
    "missing-answer",
    "missing-label",
    "extra-label",
    "wrong-choice",
    "nan",
    "infinity",
    "negative",
    "above-one",
    "underfull",
    "overfull",
    "winner-gap",
  ] as const) {
    test(`${question} ${failure} still fails validation after relaxing rounding checks`, async () => {
      const fixture = await createPermissionSession({
        classify: async (context) => {
          const result = permissionAnswer(context);
          const answer = result.answers[question];
          assert.ok(answer?.type === "choice");
          const other = Object.keys(answer.probabilities).find((key) => key !== answer.choice);
          assert.ok(other);
          if (failure === "missing-answer") delete result.answers[question];
          if (failure === "missing-label") delete answer.probabilities[other];
          if (failure === "extra-label") answer.probabilities.unexpected = 0;
          if (failure === "wrong-choice") answer.choice = "unexpected";
          if (failure === "nan") answer.probabilities[other] = Number.NaN;
          if (failure === "infinity") answer.probabilities[other] = Number.POSITIVE_INFINITY;
          if (failure === "negative") answer.probabilities[other] = -0.01;
          if (failure === "above-one") answer.probabilities[answer.choice] = 1.01;
          if (failure === "underfull" || failure === "overfull" || failure === "winner-gap") {
            const selectedProbability = failure === "winner-gap" ? 0.49 : 0.98;
            const otherProbability =
              failure === "winner-gap" ? 0.51 : failure === "overfull" ? 0.04 : 0;
            answer.probabilities = Object.fromEntries(
              Object.keys(answer.probabilities).map((key) => [
                key,
                key === answer.choice ? selectedProbability : key === other ? otherProbability : 0,
              ]),
            );
          }
          return result;
        },
      });
      try {
        const result = await fixture.run("write", { path: "invalid.txt", content: "blocked" });
        assert.equal(result.isError, true);
        assert.match(
          permissionResultText(result),
          /Reviewer returned an invalid or incomplete decision/,
        );
        await assert.rejects(readFile(join(fixture.cwd, "invalid.txt")), { code: "ENOENT" });
      } finally {
        await fixture.close();
      }
    });
  }
}
