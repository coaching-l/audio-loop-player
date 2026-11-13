import { test, expect } from "@playwright/test";
import { openAdvanced, setRepeat, expectLinuxWebKitFailure } from "./helpers.mjs";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { shellFiles, shellVersion } from "../scripts/bump-shell.mjs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Dedicated HTTP server exercises real SW fetches, including failed installs and upgrades.
// Playwright route mocks cannot reliably intercept fetches initiated inside a worker.
async function server() {
  const state = { fail: false, version: shellVersion() };
  const host = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/pomodoro/") {
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<h1>Other app</h1>");
      return;
    }
    const asset = path.startsWith("/audio-loop-player/")
      ? path.slice("/audio-loop-player/".length)
      : path.slice(1);
    const file = asset || "index.html";
    // Everything the offline cache holds, plus the worker itself.
    const allowed = [...shellFiles(), "sw.js"];
    if (
      !allowed.includes(file) ||
      (state.fail && file === "manifest.webmanifest")
    ) {
      res.writeHead(503).end("Unavailable");
      return;
    }
    try {
      let body = await readFile(resolve("" + file));
      if (file === "sw.js")
        body = Buffer.from(
          body
            .toString()
            .replace(
              /const VERSION = \"[^\"]+\";/,
              "const VERSION = " + JSON.stringify(state.version) + ";",
            ),
        );
      const type = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".mp3")
          ? "audio/mpeg"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".png")
            ? "image/png"
            : file.endsWith(".webmanifest")
              ? "application/manifest+json"
              : "text/html";
      res
        .writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const port = host.address().port;
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    close: () => {
      if (!host.listening) return Promise.resolve();
      return new Promise((resolve) => {
        host.close(resolve);
        host.closeAllConnections();
      });
    },
    // Back online at the same address (and so the same origin and caches).
    // Rejects if the port was taken meanwhile, rather than hanging until the timeout.
    reopen: () =>
      new Promise((resolve, reject) => {
        host.once("error", reject);
        host.listen(port, "127.0.0.1", () => {
          host.off("error", reject);
          resolve();
        });
      }),
  };
}
// Offline in these tests means the server is stopped, not Playwright's offline switch
// (context.setOffline): under that switch Linux WebKit reports an internal error on
// navigation. With the server gone, pages and files can only come from the service
// worker's cache. This checks that the server really cannot be reached.
async function goOffline(page, host) {
  await host.close();
  expect(
    await page.evaluate(() =>
      fetch("./not-cached-probe.txt", { cache: "no-store" }).then(
        (response) => "answered " + response.status,
        () => "unreachable",
      ),
    ),
  ).toBe("unreachable");
}
async function prepared(page) {
  await expect(page.locator("#offline-status")).toHaveAttribute(
    "data-ready",
    "true",
    { timeout: 15000 },
  );
}
async function saveAudio(page) {
  await page.locator("#file-input").setInputFiles("tests/fixtures/tone.wav");
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
for (const prefix of ["/", "/audio-loop-player/"])
  test(`offline new-tab launch, reload and practice at ${prefix}`, async ({
    page,
    context,
  }) => {
    const host = await server();
    try {
      await page.goto(host.url + prefix);
      await prepared(page);
      await saveAudio(page);
      await openAdvanced(page);
      await page.locator("#point-b").fill(".4");
      await page.locator("#point-b").press("Tab");
      await page.locator("#repeat-count").selectOption("2");
      await setRepeat(page, true);
      await goOffline(page, host);
      await page.close();
      const offline = await context.newPage();
      await offline.goto(host.url + prefix + "?practice=1");
      await expect(offline.locator("#offline-status")).toHaveAttribute(
        "data-ready",
        "true",
        { timeout: 15000 },
      );
      await offline
        .getByRole("button", { name: "tone.wavを開く", exact: true })
        .click();
      await expect(offline.locator("#play")).toBeEnabled();
      await offline.locator("#play").click();
      await expect(offline.locator("#play-status")).toHaveText("再生完了");
      await expect(offline.locator("#repeat-progress")).toHaveText(
        "完了 2 / 2 回",
      );
      // Samples never played online are still immediately available in the app shell.
      await offline.locator("#entry-text").click();
      await offline.locator("#voice-previews summary").click();
      await offline.locator('[data-voice="af_heart"]').click();
      await expect.poll(() => offline.locator("#voice-preview-audio").evaluate((a) => a.currentTime)).toBeGreaterThan(0);
      await offline.locator("#tts-lang").selectOption("zh");
      await offline.locator('[data-voice="zm_011"]').click();
      await expect.poll(() => offline.locator("#voice-preview-audio").evaluate((a) => a.currentTime)).toBeGreaterThan(0);
      const range = await offline.evaluate(async () => {
        const url = "./voice-previews/zm_011.mp3";
        const full = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const part = await fetch(url, { headers: { Range: "bytes=0-1" } });
        const invalid = await fetch(url, { headers: { Range: "bytes=99999999-" } });
        return { status: part.status, bytes: [...new Uint8Array(await part.arrayBuffer())],
          first: [...full.slice(0, 2)], invalid: invalid.status };
      });
      expect(range.status).toBe(206);
      expect(range.bytes).toEqual(range.first);
      expect(range.invalid).toBe(416);
      await offline.reload();
      await offline
        .getByRole("button", { name: "tone.wavを開く", exact: true })
        .click();
      await expect(offline.locator("#point-b")).toHaveValue("0:00.400");
      await host.reopen();
      await offline.reload();
      await prepared(offline);
    } finally {
      await host.close();
    }
  });
test("failed preparation does not claim readiness and retry recovers", async ({
  page,
}) => {
  const host = await server();
  host.state.fail = true;
  try {
    await page.goto(host.url + "/audio-loop-player/");
    await expect(page.locator("#offline-status")).toContainText(
      "完了していません",
    );
    host.state.fail = false;
    await page.locator("#usage-guide > summary").click();
    await page.locator("#offline-retry").click();
    await prepared(page);
  } finally {
    await host.close();
  }
});
test("failed update keeps the old offline app; successful update preserves audio and sibling caches", async ({
  page,
}) => {
  const host = await server();
  try {
    await page.goto(host.url + "/audio-loop-player/");
    await prepared(page);
    await saveAudio(page);
    await page.evaluate(async () => {
      const c = await caches.open("pomodoro-offline-v1");
      await c.put("/pomodoro/", new Response("keep"));
    });
    host.state.version = "test-v5";
    host.state.fail = true;
    await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      await r.update();
      if (r.installing)
        await new Promise((resolve) => {
          const worker = r.installing;
          worker.addEventListener("statechange", () => {
            if (["redundant", "installed"].includes(worker.state)) resolve();
          });
        });
    });
    await goOffline(page, host);
    await page.reload();
    await expect(page.locator("#offline-status")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15000 },
    );
    await expect(page.locator(".audio-item")).toHaveCount(1);
    await host.reopen();
    host.state.fail = false;
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration()).update();
    });
    await page.locator("#usage-guide > summary").click();
    await expect(page.locator("#offline-update")).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#offline-update").click(),
    ]);
    await prepared(page);
    expect(
      await page.evaluate(async () => {
        const keys = await caches.keys();
        return (
          keys.includes("pomodoro-offline-v1") &&
          keys.includes(
            "coaching-l-audio-offline:/audio-loop-player/:test-v5",
          ) &&
          !keys.includes("coaching-l-audio-offline:/audio-loop-player/:v4")
        );
      }),
    ).toBe(true);
    await expect(page.locator(".audio-item")).toHaveCount(1);
    await goOffline(page, host);
    await page.reload();
    await page
      .getByRole("button", { name: "tone.wavを開く", exact: true })
      .click();
    await page.locator("#play").click();
    await expect
      .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
      .toBeGreaterThan(0.1);
  } finally {
    await host.close();
  }
});

test("missing shell cache is detected and can be prepared again", async ({
  page,
}) => {
  const host = await server();
  try {
    await page.goto(host.url + "/audio-loop-player/");
    await prepared(page);
    await page.evaluate(async () => {
      for (const key of await caches.keys())
        if (key.startsWith("coaching-l-audio-offline:"))
          await caches.delete(key);
    });
    await page.reload();
    await expect(page.locator("#offline-status")).toContainText(
      "完了していません",
    );
    await page.locator("#usage-guide > summary").click();
    await page.locator("#offline-retry").click();
    await prepared(page);
    await goOffline(page, host);
    await page.reload();
    await expect(page.locator("#offline-status")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15000 },
    );
    // The reloaded page is the app itself, served from the cache.
    await expect(page.locator("#entry-audio")).toBeVisible();
  } finally {
    await host.close();
  }
});
test("cold browser restart can open the saved app and audio offline", async ({
  browser,
  browserName,
}, testInfo) => {
  // Unlike the tests above, this one fails on Linux WebKit before going offline: in a
  // persistent context the first, online preparation never finishes. Stopping the
  // server instead of the offline switch would not help, so it keeps its marker.
  expectLinuxWebKitFailure(
    browserName,
    "Linux WebKit: the offline preparation does not finish here (see DEVELOPMENT.md)",
  );
  const host = await server();
  const profile = await mkdtemp(join(tmpdir(), "audio-offline-profile-"));
  let session;
  const use = testInfo.project.use;
  const options = {
    ...use.launchOptions,
    headless: true,
    viewport: use.viewport,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
  };
  try {
    session = await browser
      .browserType()
      .launchPersistentContext(profile, options);
    let page = await session.newPage();
    await page.goto(host.url + "/audio-loop-player/");
    await prepared(page);
    await saveAudio(page);
    await session.close();
    session = null;
    await host.close();
    session = await browser
      .browserType()
      .launchPersistentContext(profile, { ...options, offline: true });
    page = await session.newPage();
    await page.goto(host.url + "/audio-loop-player/");
    await expect(page.locator("#offline-status")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15000 },
    );
    await page
      .getByRole("button", { name: "tone.wavを開く", exact: true })
      .click();
    await expect(page.locator("#play")).toBeEnabled();
    await page.locator("#play").click();
    await expect
      .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
      .toBeGreaterThan(0.1);
  } finally {
    await session?.close();
    await host.close();
    await rm(profile, { recursive: true, force: true });
  }
});
