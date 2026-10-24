// Release helper: after changing any file the offline cache holds, run `npm run bump-shell`.
// It raises the cache VERSION and the CSS/JS query strings, then records the shell's hash
// so tests/release.spec.js can catch a release that changed files without a new version.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const write = (path, text) => writeFileSync(new URL(path, root), text);
export const recordPath = "tests/shell-version.json";

export function shellFiles(sw = read("sw.js")) {
  const paths = [...sw.matchAll(/^\s+"\.\/([^"]*)",$/gm)].map(
    (match) => match[1].split("?")[0] || "index.html",
  );
  return [...new Set(paths)].sort();
}
export function shellHash(sw = read("sw.js")) {
  const hash = createHash("sha256");
  for (const path of shellFiles(sw))
    hash.update(path + "\0").update(readFileSync(new URL(path, root)));
  return hash.digest("hex");
}
export function shellVersion(sw = read("sw.js")) {
  return /const VERSION = "([^"]+)";/.exec(sw)[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = (text) =>
    text.replace(/\?v=(\d+)/g, (_, n) => `?v=${Number(n) + 1}`);
  let sw = read("sw.js").replace(
    /const VERSION = "v(\d+)";/,
    (_, n) => `const VERSION = "v${Number(n) + 1}";`,
  );
  sw = next(sw);
  write("sw.js", sw);
  write("index.html", next(read("index.html")));
  const record = { version: shellVersion(sw), hash: shellHash(sw) };
  write(recordPath, JSON.stringify(record, null, 2) + "\n");
  console.log(`Offline cache is now ${record.version}.`);
}
