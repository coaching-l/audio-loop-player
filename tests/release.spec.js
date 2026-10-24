import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";

// The offline cache is a hand-maintained list; catch a release that forgets to update it.
const read = (path) => readFileSync(path, "utf8");
const cached = [...read("sw.js").matchAll(/^\s+"\.\/([^"]*)",$/gm)].map(
  (match) => match[1],
);

test("service worker caches every file the page and manifest load", () => {
  const html = read("index.html");
  const referenced = [...html.matchAll(/(?:href|src)="\.\/([^"#]+)"/g)].map(
    (match) => match[1],
  );
  const manifest = JSON.parse(read("manifest.webmanifest"));
  for (const icon of manifest.icons) referenced.push(icon.src.slice(2));
  const modules = [
    ...read("app.js").matchAll(/from "\.\/([^"]+)"|import "\.\/([^"]+)"/g),
  ].map((match) => match[1] || match[2]);
  for (const path of [...referenced, ...modules]) {
    expect(cached, `${path} is missing from sw.js FILES`).toContain(path);
    expect(existsSync(path.split("?")[0]), `${path} does not exist`).toBe(true);
  }
});

test("manifest meets install requirements for Android", () => {
  const { icons } = JSON.parse(read("manifest.webmanifest"));
  const sizes = icons
    .filter((icon) => icon.purpose !== "maskable")
    .map((icon) => icon.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
});

test("changed offline files come with a new cache version", async () => {
  const { shellHash, shellVersion, recordPath } =
    await import("../scripts/bump-shell.mjs");
  const record = JSON.parse(read(recordPath));
  expect(
    shellHash(),
    "Files in sw.js FILES changed. Run `npm run bump-shell` before releasing.",
  ).toBe(record.hash);
  expect(
    shellVersion(),
    "sw.js VERSION differs from the recorded release. Run `npm run bump-shell`.",
  ).toBe(record.version);
});
