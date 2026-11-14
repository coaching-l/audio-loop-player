import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import worker, { verifyAccessToken, resetKeyCacheForTests } from "../workers/auth-poc/worker.js";

// Everything outside this process is a stand-in: the Access signing keys are made here,
// and the "paid API" is a counter. No real Cloudflare, DeepL, OpenAI or Claude call.
const TEAM = "https://audio-loop-test.cloudflareaccess.com";
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

let accessKey, strangerKey;
const calls = { upstream: [], keys: 0 };
let keysAvailable = true;
const realFetch = globalThis.fetch;

// Stands in for the network the Worker reaches: Access's public keys and the paid API.
function fakeNetwork(input, init) {
  const url = typeof input === "string" ? input : input.url;
  if (url === `${TEAM}/cdn-cgi/access/certs`) {
    calls.keys++;
    if (!keysAvailable) return Promise.resolve(new Response("down", { status: 500 }));
    return Promise.resolve(Response.json({ keys: [accessKey.jwk] }));
  }
  if (url === UPSTREAM) {
    calls.upstream.push({ headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    return Promise.resolve(Response.json({ ok: true }));
  }
  return realFetch(input, init);
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
  globalThis.fetch = fakeNetwork;
});
test.afterAll(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => {
  calls.upstream = [];
  calls.keys = 0;
  keysAvailable = true;
  resetKeyCacheForTests();
});

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
  let app, api, appOrigin, apiOrigin;
  let accessUser = USER; // who Access says is signed in (null: nobody)

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
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      headers.delete("cf-access-jwt-assertion");
      if (req.url.startsWith("/auth/")) {
        if (!accessUser) return res.writeHead(302, { Location: `${TEAM}/cdn-cgi/access/login` }).end();
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
    appOrigin = `http://127.0.0.1:${app.address().port}`;
    apiOrigin = `http://127.0.0.1:${api.address().port}`;
  });
  test.afterAll(async () => {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => api.close(resolve));
  });

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

  test("a message that does not come from the sign-in window is ignored", async ({ page }) => {
    accessUser = null; // the window only reaches Access's login page
    await page.goto(appOrigin);
    await Promise.all([page.waitForEvent("popup"), page.locator("#in").click()]);
    // Same shape, but sent by the page itself: wrong window (and the state is unknown).
    await page.evaluate(() => window.postMessage({ type: "audio-loop-auth", state: "x".repeat(32), token: "a.b.c", exp: 9e9 }, "*"));
    expect(await page.evaluate(() => window.result)).toBe("timeout");
    expect(await page.evaluate(() => window.auth.signedIn())).toBe(false);
    expect(calls.upstream).toHaveLength(0);
  });
});
