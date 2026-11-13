import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";

// scripts/serve.mjs is imported by tests for a server of their own: importing it must
// not start the development server, nor fail when the entry is not a file.
test("importing the development server only provides serveFile", ({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Node only; once is enough.");
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-"],
    {
      input:
        'const m = await import("./scripts/serve.mjs"); console.log(typeof m.serveFile);',
      encoding: "utf8",
      // Both set (as test runners may do) makes Node print a warning to standard error.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== "NO_COLOR" && name !== "FORCE_COLOR",
        ),
      ),
      timeout: 10000,
    },
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe("function");
});
