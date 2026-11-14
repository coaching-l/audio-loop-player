import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import worker, { verifyAccessToken, resetKeyCacheForTests } from "../workers/auth-poc/worker.js";

// Everything outside this process is a stand-in: the Access signing keys are made here,
// and the "paid API" is a counter. No real Cloudflare, DeepL, OpenAI or Claude call.
const TEAM = "https://audio-loop-test.cloudflareaccess.com";
const TEAM_B = "https://audio-loop-other.cloudflareaccess.com";
const AUD = "a".repeat(64);
const OTHER_AUD = "b".repeat(64);
const UPSTREAM = "https://paid-api.invalid/v1/run";
const USER = "admin@example.com";

const encode = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e } };
}

async function sign(claims, key, header = {}) {
  const head = encode({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = encode(claims);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

const now = () => Math.floor(Date.now() / 1000);
const claims = (extra = {}) => ({
  aud: [AUD], email: USER, exp: now() + 600, iat: now() - 5, nbf: now() - 5,
  iss: TEAM, type: "app", identity_nonce: "n", sub: "user-1", country: "JP", ...extra,
});

let accessKey, strangerKey, nextKey, teamBKey;
let holdTeamKeys = null; // when set, the first team's key fetch waits for this promise
const calls = { upstream: [], keys: 0, unexpected: [] };
let keysAvailable = true;
let publishedKeys = () => [accessKey.jwk];
const realFetch = globalThis.fetch;

// Stands in for the network the Worker reaches: Access's public keys and the paid API.
function fakeNetwork(input, init) {
  const url = typeof input === "string" ? input : input.url;
  if (url === `${TEAM}/cdn-cgi/access/certs`) {
    calls.keys++;
    if (!keysAvailable) return Promise.resolve(new Response("down", { status: 500 }));
    // A short delay, so requests that arrive together really overlap.
    const answer = () => Response.json({ keys: publishedKeys() });
    if (holdTeamKeys) return holdTeamKeys.then(answer);
    return new Promise((resolve) => setTimeout(() => resolve(answer()), 20));
  }
  if (url === `${TEAM_B}/cdn-cgi/access/certs`) {
    calls.keys++;
    return Promise.resolve(Response.json({ keys: [teamBKey.jwk] }));
  }
  if (url === UPSTREAM) {
    calls.upstream.push({ headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    return Promise.resolve(Response.json({ ok: true }));
  }
  // Nothing else may leave this process.
  calls.unexpected.push(url);
  return Promise.reject(new Error(`unexpected network request: ${url}`));
}

const APP = "https://tools.coaching-l.net";
const env = (extra = {}) => ({
  ENABLED: "true", TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, APP_ORIGIN: APP,
  ALLOWED_EMAILS: `${USER}, second@example.com`, UPSTREAM_URL: UPSTREAM, UPSTREAM_KEY: "test-upstream-key", ...extra,
});
const apiCall = (token, extra = {}) => new Request("https://auth-poc.example.workers.dev/api/run", {
  method: "POST",
  headers: { Origin: APP, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra.headers },
  body: JSON.stringify(extra.body ?? { text: "hello" }),
});

test.beforeAll(async () => {
  accessKey = await makeKey("access-key-1");
  strangerKey = await makeKey("access-key-1"); // same key id, different key: a forgery
  nextKey = await makeKey("access-key-2"); // the key Access rotates to
  teamBKey = await makeKey("team-b-key"); // another team's key
  globalThis.fetch = fakeNetwork;
});
test.afterAll(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => {
  calls.upstream = [];
  calls.keys = 0;
  calls.unexpected = [];
  keysAvailable = true;
  publishedKeys = () => [accessKey.jwk];
  holdTeamKeys = null;
  resetKeyCacheForTests();
});
test.afterEach(() => {
  expect(calls.unexpected).toEqual([]);
});
// Moves the clock the Worker sees, to cross its waiting times without waiting.
const realNow = Date.now;
const later = (ms) => { const at = realNow() + ms; Date.now = () => at; };
test.afterEach(() => { Date.now = realNow; });

test.describe("Worker checks (Node only)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Runs in Node; once is enough.");
  });

  test("an allowed, signed-in user reaches the paid API once, with the key added only there", async () => {
    const response = await worker.fetch(apiCall(await sign(claims(), accessKey)), env());
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(calls.upstream).toHaveLength(1);
    expect(calls.upstream[0].body).toEqual({ text: "hello", user: "user-1" });
    expect(calls.upstream[0].headers.authorization).toBe("Bearer test-upstream-key");
  });

  test("every bad or missing sign-in is refused before the paid API is called", async () => {
    const cases = {
      "no token": [null, 401],
      "not a JWT": ["abc", 401],
      "forged signature": [await sign(claims(), strangerKey), 401],
      "expired": [await sign(claims({ exp: now() - 120 }), accessKey), 401],
      "not valid yet": [await sign(claims({ nbf: now() + 600 }), accessKey), 401],
      "issued in the future": [await sign(claims({ iat: now() + 600 }), accessKey), 401],
      "another Access application": [await sign(claims({ aud: [OTHER_AUD] }), accessKey), 401],
      "another team (issuer)": [await sign(claims({ iss: "https://evil.cloudflareaccess.com" }), accessKey), 401],
      "service token, not a user": [await sign(claims({ email: undefined, common_name: "x.access" }), accessKey), 401],
      "unsigned (alg none)": [`${encode({ alg: "none", kid: "access-key-1" })}.${encode(claims())}.`, 401],
      "HMAC algorithm": [await sign(claims(), accessKey, { alg: "HS256" }), 401],
      "unknown key id": [await sign(claims(), accessKey, { kid: "other" }), 401],
      "user not on the allowed list": [await sign(claims({ email: "someone@example.com" }), accessKey), 403],
    };
    for (const [name, [token, status]] of Object.entries(cases)) {
      const response = await worker.fetch(apiCall(token), env());
      expect(response.status, name).toBe(status);
      const text = await response.text();
      // The answer never carries the token back.
      if (token) expect(text.includes(token.split(".")[1]), name).toBe(false);
    }
    expect(calls.upstream).toHaveLength(0);
  });

  test("taking the user off the allowed list stops a still-valid token at once", async () => {
    const token = await sign(claims(), accessKey);
    expect((await worker.fetch(apiCall(token), env())).status).toBe(200);
    const response = await worker.fetch(apiCall(token), env({ ALLOWED_EMAILS: "second@example.com" }));
    expect(response.status).toBe(403);
    expect(calls.upstream).toHaveLength(1);
  });

  test("when Access's keys cannot be fetched, nothing is allowed (fail closed)", async () => {
    keysAvailable = false;
    const response = await worker.fetch(apiCall(await sign(claims(), accessKey)), env());
    expect(response.status).toBe(503);
    expect(calls.upstream).toHaveLength(0);
  });

  test("time claims must be finite numbers, even in a correctly signed token", async () => {
    const raw = async (json) => {
      const head = encode({ alg: "RS256", kid: accessKey.kid, typ: "JWT" });
      const body = Buffer.from(json).toString("base64url");
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", accessKey.privateKey, Buffer.from(`${head}.${body}`));
      return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
    };
    const base = claims();
    for (const [name, token] of [
      ["nbf as text", await sign(claims({ nbf: String(now() - 5) }), accessKey)],
      ["iat as an object", await sign(claims({ iat: {} }), accessKey)],
      ["exp as null", await sign(claims({ exp: null }), accessKey)],
      ["no exp", await sign(claims({ exp: undefined }), accessKey)],
      ["exp that becomes Infinity", await raw(JSON.stringify(base).replace(`"exp":${base.exp}`, '"exp":1e999'))],
    ]) {
      expect((await worker.fetch(apiCall(token), env())).status, name).toBe(401);
    }
    expect(calls.upstream).toHaveLength(0);
  });

  test("requests arriving together share one fetch of Access's keys", async () => {
    const token = await sign(claims(), accessKey);
    const answers = await Promise.all(Array.from({ length: 20 }, () => worker.fetch(apiCall(null, {
      headers: { Authorization: `Bearer ${token.replace(/\.[^.]+$/, ".AAAA")}` },
    }), env())));
    expect(answers.every((response) => response.status === 401)).toBe(true);
    expect(calls.keys).toBe(1);
    expect(calls.upstream).toHaveLength(0);
  });

  test("a failed key fetch is not retried on every request", async () => {
    keysAvailable = false;
    const token = await sign(claims(), accessKey);
    for (let i = 0; i < 10; i++) expect((await worker.fetch(apiCall(token), env())).status).toBe(503);
    expect(calls.keys).toBe(1);
    // After the waiting time, one new attempt; with the keys back, the user gets in.
    keysAvailable = true;
    later(61000);
    expect((await worker.fetch(apiCall(await sign(claims(), accessKey)), env())).status).toBe(200);
    expect(calls.keys).toBe(2);
    expect(calls.upstream).toHaveLength(1);
  });

  test("unknown key ids do not trigger a fetch each time; a rotated key is picked up", async () => {
    expect((await worker.fetch(apiCall(await sign(claims(), accessKey)), env())).status).toBe(200);
    expect(calls.keys).toBe(1);
    // Access rotates to a new key. Within the waiting time, tokens signed with it are not
    // yet known (401) and cause no fetch; afterwards the keys are fetched once again.
    publishedKeys = () => [nextKey.jwk, accessKey.jwk];
    const rotated = await sign(claims(), nextKey);
    for (let i = 0; i < 5; i++) expect((await worker.fetch(apiCall(rotated), env())).status).toBe(401);
    expect(calls.keys).toBe(1);
    later(61000);
    expect((await worker.fetch(apiCall(rotated), env())).status).toBe(200);
    expect(calls.keys).toBe(2);
    expect(calls.upstream).toHaveLength(2);
  });

  test("a slow key fetch for the old team cannot fill the new team's keys", async () => {
    // The settings change while the first team's key fetch is still running (Cloudflare
    // may keep the same isolate when only settings change).
    let release;
    holdTeamKeys = new Promise((resolve) => { release = resolve; });
    const teamB = env({ TEAM_DOMAIN: TEAM_B });
    const oldTeam = worker.fetch(apiCall(await sign(claims(), accessKey)), env());
    await new Promise((resolve) => setTimeout(resolve, 10)); // the old fetch has started
    const forTeamB = (key, extra = {}) => sign(claims({ iss: TEAM_B, ...extra }), key);
    expect((await worker.fetch(apiCall(await forTeamB(teamBKey)), teamB)).status).toBe(200);
    release();
    expect((await oldTeam).status).toBe(200);
    // Team B still accepts its own token, and still refuses one signed with the old
    // team's key that claims to come from team B.
    expect((await worker.fetch(apiCall(await forTeamB(teamBKey)), teamB)).status).toBe(200);
    expect((await worker.fetch(apiCall(await forTeamB(accessKey)), teamB)).status).toBe(401);
    expect(calls.upstream).toHaveLength(3);
  });

  test("missing or unsafe settings disable the API instead of opening it", async () => {
    const token = await sign(claims(), accessKey);
    for (const extra of [
      { ENABLED: "false" }, { TEAM_DOMAIN: "" }, { TEAM_DOMAIN: "https://evil.example.com" },
      { ACCESS_AUD: "" }, { ALLOWED_EMAILS: "" }, { APP_ORIGIN: "*" },
    ]) {
      const response = await worker.fetch(apiCall(token), env(extra));
      expect(response.status, JSON.stringify(extra)).toBe(503);
    }
    expect(calls.upstream).toHaveLength(0);
  });

  test("calls from another site, other methods and bad bodies never reach the paid API", async () => {
    const token = await sign(claims(), accessKey);
    expect((await worker.fetch(apiCall(token, { headers: { Origin: "https://evil.example" } }), env())).status).toBe(403);
    const noOrigin = apiCall(token);
    const headers = new Headers(noOrigin.headers);
    headers.delete("Origin");
    expect((await worker.fetch(new Request(noOrigin, { headers }), env())).status).toBe(403);
    expect((await worker.fetch(new Request("https://w.example/api/run", { headers: { Origin: APP, Authorization: `Bearer ${token}` } }), env())).status).toBe(405);
    expect((await worker.fetch(apiCall(token, { body: { text: "x".repeat(5000) } }), env())).status).toBe(413);
    expect((await worker.fetch(apiCall(token, { body: { text: "" } }), env())).status).toBe(400);
    const preflight = await worker.fetch(new Request("https://w.example/api/run", {
      method: "OPTIONS", headers: { Origin: APP, "Access-Control-Request-Method": "POST" },
    }), env());
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(calls.upstream).toHaveLength(0);
  });

  test("the sign-in hand-off gives the token only for a verified user, never in a URL", async () => {
    const state = "s".repeat(32);
    const handoff = (token, query = `?state=${state}`) => worker.fetch(new Request(
      `https://w.example/auth/handoff${query}`,
      { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} },
    ), env());
    const token = await sign(claims(), accessKey);
    const page = await handoff(token);
    expect(page.status).toBe(200);
    expect(page.headers.get("Location")).toBeNull();
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain(`postMessage(data, "${APP}")`);
    expect(html).not.toContain('"*"');
    // A forged header (as if Access were switched off), a bad state, or no sign-in: no token.
    for (const [bad, query, status] of [
      [await sign(claims(), strangerKey), undefined, 401],
      [null, undefined, 401],
      [await sign(claims({ email: "someone@example.com" }), accessKey), undefined, 403],
      [token, "?state=short", 400],
      [token, "", 400],
    ]) {
      const response = await handoff(bad, query);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(token.split(".")[1]);
    }
    expect(calls.upstream).toHaveLength(0);
  });

  test("a closing \"</script>\" in a claim cannot break out of the hand-off page", async () => {
    const token = await sign(claims({ country: "</script><script>alert(1)</script>" }), accessKey);
    const html = await (await worker.fetch(new Request(`https://w.example/auth/handoff?state=${"s".repeat(32)}`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    }), env())).text();
    // The token is base64url, so no claim text appears in the page at all.
    expect(html).not.toContain("alert(1)");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  test("verification reports a reason, with no identity, for each failure", async () => {
    const config = { team: TEAM, aud: AUD, users: [USER] };
    expect(await verifyAccessToken(await sign(claims({ aud: AUD }), accessKey), config)).toMatchObject({ email: USER, sub: "user-1" });
    const refused = await verifyAccessToken(await sign(claims({ email: "x@example.com" }), accessKey), config);
    expect(refused).toEqual({ error: "not_allowed" });
  });
});

// The browser part: the app page and the Worker on two origins, as on the real site.
test.describe("sign-in window and API call in a browser", () => {
  let app, api, appOrigin, apiOrigin, lastState;
  let accessUser = USER; // who Access says is signed in (null: nobody)
  let blocked = [];
  let outside, outsideOrigin, outsideHits = 0; // a local server the browser must not reach

  test.beforeAll(async () => {
    const clientCode = await readFile("workers/auth-poc/client.js");
    app = createServer((req, res) => {
      if (req.url === "/client.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(clientCode);
      res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><button id="in">ログイン</button>
<script type="module">
import { createAuthClient } from "/client.js";
window.auth = createAuthClient({ apiOrigin: ${JSON.stringify("API_ORIGIN")}, timeout: 3000 });
document.getElementById("in").onclick = () => { window.result = window.auth.signIn().then(() => "ok", (e) => e.message); };
</script>`.replace('"API_ORIGIN"', () => JSON.stringify(apiOrigin)));
    });
    api = createServer(async (req, res) => {
      // Plays Cloudflare's part: Access in front of /auth/* only, adding its signed token.
      // Its login page is a local stand-in, so the browser never leaves this machine.
      if (req.url.startsWith("/mock-login")) return res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Access login (stand-in)</p>");
      // Only for the check that the blocking also stops redirects.
      if (req.url === "/redirect-out") return res.writeHead(302, { Location: `${outsideOrigin}/` }).end();
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      headers.delete("cf-access-jwt-assertion");
      if (req.url.startsWith("/auth/")) {
        lastState = new URL(req.url, apiOrigin).searchParams.get("state");
        // Not signed in: Access would redirect to its login page; the stand-in shows it
        // directly, so the browser follows no redirect here.
        if (!accessUser) return res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Access login (stand-in)</p>");
        headers.set("cf-access-jwt-assertion", await sign(claims({ email: accessUser }), accessKey));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await worker.fetch(new Request(apiOrigin + req.url, {
        method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      }), env({ APP_ORIGIN: appOrigin }));
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    outside = createServer((req, res) => { outsideHits++; res.end("reached"); });
    await new Promise((resolve) => outside.listen(0, "127.0.0.1", resolve));
    outsideOrigin = `http://127.0.0.1:${outside.address().port}`;
    appOrigin = `http://127.0.0.1:${app.address().port}`;
    apiOrigin = `http://127.0.0.1:${api.address().port}`;
  });
  test.afterAll(async () => {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => api.close(resolve));
    await new Promise((resolve) => outside.close(resolve));
  });
  // The browser may only reach the two local servers. Every request passes through here,
  // and no redirect is followed behind its back: the test servers do not redirect (except
  // the one check below), so any redirect is stopped and recorded. (Handing a redirect back
  // to the browser is not possible in WebKit: "Cannot fulfill with redirect status".)
  test.beforeEach(async ({ context }) => {
    blocked = [];
    outsideHits = 0;
    const allowed = (url) => [appOrigin, apiOrigin].includes(new URL(url).origin);
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (!allowed(url)) {
        blocked.push(url);
        return route.abort();
      }
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location;
      if (location) {
        blocked.push(new URL(location, url).href);
        return route.abort();
      }
      return route.fulfill({ response });
    });
  });
  test.afterEach(() => {
    expect(blocked).toEqual([]);
    expect(outsideHits).toBe(0);
  });

  test("the blocking also stops a redirect from an allowed server to another one", async ({ page }) => {
    // The control: without the blocking, this redirect reaches the outside server.
    await page.goto(`${apiOrigin}/redirect-out`).catch(() => {});
    expect(outsideHits).toBe(0);
    expect(blocked).toEqual([`${outsideOrigin}/`]);
    blocked = [];
  });

  // A sign-in left waiting on Access's login page, with what a real answer would carry.
  async function waitingSignIn(page) {
    accessUser = null;
    await page.goto(appOrigin);
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 10000 }), page.locator("#in").click()]);
    await expect(popup.locator("body")).toContainText("stand-in");
    expect(new URL(popup.url()).pathname).toBe("/auth/handoff");
    const answer = { type: "audio-loop-auth", state: lastState, token: "a.b.c", exp: 9e9 };
    return { popup, answer };
  }
  const post = (from, message, to = "opener") =>
    from.evaluate(([message, to]) => window[to].postMessage(message, "*"), [message, to]);

  test("signing in through the window lets the app call the API; nothing is stored", async ({ page }, testInfo) => {
    accessUser = USER;
    await page.goto(appOrigin);
    expect(await page.evaluate(() => window.auth.call("/api/run", { text: "hi" }).catch((e) => e.message))).toBe("sign_in_required");
    expect(calls.upstream).toHaveLength(0);
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 10000 }), page.locator("#in").click()]);
    expect(await page.evaluate(() => window.result)).toBe("ok");
    // Whether the window closes itself differs by browser (the iPhone setting in Linux
    // WebKit did not report it); the token hand-off above is what matters. Record it only.
    const closed = await popup.waitForEvent("close", { timeout: 5000 }).then(() => true, () => popup.isClosed());
    testInfo.annotations.push({ type: "sign-in window closed itself", description: String(closed) });
    expect(await page.evaluate(() => window.auth.signedIn())).toBe(true);
    const status = await page.evaluate(() => window.auth.call("/api/run", { text: "hi" }).then((r) => r.status));
    expect(status).toBe(200);
    expect(calls.upstream).toHaveLength(1);
    // The token is not left in the page's storage or URL.
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie, location.search])).toEqual([0, 0, "", ""]);
    await page.evaluate(() => window.auth.signOut());
    expect(await page.evaluate(() => window.auth.call("/api/run", { text: "hi" }).catch((e) => e.message))).toBe("sign_in_required");
    expect(calls.upstream).toHaveLength(1);
  });

  test("a user Access lets in but who is not on the list gets no token and no API call", async ({ page }) => {
    accessUser = "someone@example.com";
    await page.goto(appOrigin);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator("#in").click()]);
    await expect(popup.locator("body")).toContainText("not_allowed");
    expect(await page.evaluate(() => window.result)).toBe("timeout");
    expect(await page.evaluate(() => window.auth.signedIn())).toBe(false);
    expect(calls.upstream).toHaveLength(0);
  });

  test("the answer is accepted from the sign-in window, at the API's origin, for this attempt", async ({ page }) => {
    // The control case: the stand-in setup can succeed, so the cases below fail for their
    // one wrong detail only.
    const { popup, answer } = await waitingSignIn(page);
    await post(popup, answer);
    expect(await page.evaluate(() => window.result)).toBe("ok");
    expect(await page.evaluate(() => window.auth.signedIn())).toBe(true);
  });

  test("an answer with one wrong detail is ignored: origin, window or attempt", async ({ page }) => {
    // Right window and attempt, but from another origin (the window was sent elsewhere).
    let { popup, answer } = await waitingSignIn(page);
    await popup.goto(`${appOrigin}/elsewhere`);
    await post(popup, answer);
    expect(await page.evaluate(() => window.result)).toBe("timeout");
    // (The sign-in window has a name, so a new attempt would reuse it: close it first.)
    await popup.close();
    // Right origin and attempt, but another window (a frame of the API's origin).
    ({ popup, answer } = await waitingSignIn(page));
    await page.evaluate((src) => new Promise((resolve) => {
      const frame = Object.assign(document.createElement("iframe"), { src, onload: resolve });
      document.body.append(frame);
    }), `${apiOrigin}/mock-login`);
    await post(page.frames().find((frame) => frame.url().includes("/mock-login")), answer, "parent");
    expect(await page.evaluate(() => window.result)).toBe("timeout");
    await popup.close();
    // Right origin and window, but for another attempt.
    ({ popup, answer } = await waitingSignIn(page));
    await post(popup, { ...answer, state: "y".repeat(32) });
    expect(await page.evaluate(() => window.result)).toBe("timeout");
    expect(await page.evaluate(() => window.auth.signedIn())).toBe(false);
    expect(calls.upstream).toHaveLength(0);
  });

  test("signing out while a sign-in waits makes its late answer count for nothing", async ({ page }) => {
    const { popup, answer } = await waitingSignIn(page);
    await page.evaluate(() => window.auth.signOut());
    await post(popup, answer);
    expect(await page.evaluate(() => window.result)).toBe("signed_out");
    expect(await page.evaluate(() => window.auth.signedIn())).toBe(false);
    expect(await page.evaluate(() => window.auth.call("/api/run", { text: "hi" }).catch((e) => e.message))).toBe("sign_in_required");
    expect(calls.upstream).toHaveLength(0);
  });
});
