import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = resolve(import.meta.dirname, "..");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const file = resolve(
      root,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (
      !file.startsWith(root + sep) ||
      pathname.split("/").some((part) => part.startsWith(".")) ||
      pathname.startsWith("/node_modules/") ||
      pathname.startsWith("/tests/")
    ) {
      res.writeHead(403).end();
      return;
    }
    if (!(await stat(file)).isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(Number(process.env.PORT || 4173), "0.0.0.0", () =>
  console.log("Audio Loop Player server on port " + (process.env.PORT || 4173)),
);
