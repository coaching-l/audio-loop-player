import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Dedicated HTTP server exercises real SW fetches, including failed installs and upgrades.
// Playwright route mocks cannot reliably intercept fetches initiated inside a worker.
async function server() {
  const state = { fail: false, version: "v5" };
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
    const allowed = [
      "index.html",
      "app.js",
      "offline.js",
      "sw.js",
      "player.js",
      "audio-library.js",
      "audio-import.js",
      "style.css",
      "manifest.webmanifest",
      "icons/logo-144.png",
      "icons/favicon-32.png",
      "icons/icon-192.png",
      "icons/icon-512.png",
      "icons/icon-maskable-512.png",
      "icons/apple-touch-icon.png",
    ];
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
  return {
    state,
    url: `http://127.0.0.1:${host.address().port}`,
    close: () => {
      if (!host.listening) return Promise.resolve();
      return new Promise((resolve) => {
        host.close(resolve);
        host.closeAllConnections();
      });
    },
  };
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
      await page.locator("#point-b").fill(".4");
      await page.locator("#point-b").press("Tab");
      await page.locator("#repeat-mode").selectOption("ab");
      await page.close();
      await context.setOffline(true);
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
      await offline.locator("#segment-name").fill("機内で練習");
      await offline
        .getByRole("button", { name: "区間を保存", exact: true })
        .click();
      await offline.reload();
      await offline
        .getByRole("button", { name: "tone.wavを開く", exact: true })
        .click();
      await expect(offline.locator(".segment-name")).toHaveText("機内で練習");
      await context.setOffline(false);
      await offline.reload();
      await prepared(offline);
    } finally {
      await context.setOffline(false);
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
  context,
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
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator("#offline-status")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15000 },
    );
    await expect(page.locator(".audio-item")).toHaveCount(1);
    await context.setOffline(false);
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
    await context.setOffline(true);
    await page.reload();
    await page
      .getByRole("button", { name: "tone.wavを開く", exact: true })
      .click();
    await page.locator("#play").click();
    await expect
      .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
      .toBeGreaterThan(0.1);
  } finally {
    await context.setOffline(false);
    await host.close();
  }
});

test("missing shell cache is detected and can be prepared again", async ({
  page,
  context,
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
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator("#offline-status")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15000 },
    );
  } finally {
    await context.setOffline(false);
    await host.close();
  }
});
test("cold browser restart can open the saved app and audio offline", async ({
  browser,
}, testInfo) => {
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
