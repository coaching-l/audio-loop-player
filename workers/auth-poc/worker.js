// Verification Worker (not deployed): Cloudflare Access sign-in for an API used from
// another site (https://tools.coaching-l.net calling a workers.dev Worker).
//
// Why not just Access's cookie: the app and this Worker are different sites, so the
// CF_Authorization cookie on the Worker would be a third-party cookie, which Safari
// blocks. Instead:
//   1. /auth/handoff is protected by an Access application (path-based). Access signs
//      the user in (email one-time PIN) and adds the signed Access token (JWT) to the
//      request as the Cf-Access-Jwt-Assertion header.
//   2. The Worker verifies that token, then gives it to the app window that opened the
//      sign-in window (postMessage to the app's exact origin; never in a URL).
//   3. The app sends it as "Authorization: Bearer ..." to /api/*. /api/* is not behind
//      Access (the cookie would not arrive), so the Worker itself verifies every token:
//      Access signature, issuer, audience, expiry and the allowed users.
// No token of our own is made: the only token is the one Access issued and signed.
// Nothing upstream is called until all checks pass. Fail closed on any doubt.

const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const STATE = /^[A-Za-z0-9_-]{22,64}$/;
// The app's exact origin: https, or a local http origin for development and tests.
const APP_ORIGIN = /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;
const LEEWAY = 30; // seconds of clock difference accepted for exp / nbf / iat
const KEYS_TTL = 10 * 60 * 1000;
// Fetching the keys again (after a failure, or for an unknown key id) waits at least this
// long, so requests cannot make the Worker fetch them over and over.
const KEYS_RETRY = 60 * 1000;
const KEYS_TIMEOUT = 5000;
const MAX_TOKEN = 8192;
const MAX_BODY = 4000;

// Public keys, per isolate, kept separately for each key address (team). Never a token or
// an identity. One fetch at a time per address: requests that arrive meanwhile wait for
// it, and a failed fetch counts as an attempt too. A fetch writes only into the entry it
// started for, so a slow answer for one team can never fill another team's entry.
const keyCaches = new Map();
const MAX_TEAMS = 4;

export function resetKeyCacheForTests() {
  keyCaches.clear();
}

function keyEntry(url) {
  let entry = keyCaches.get(url);
  if (!entry) {
    if (keyCaches.size >= MAX_TEAMS) keyCaches.delete(keyCaches.keys().next().value);
    entry = { keys: null, fetched: 0, attempted: 0, pending: null };
    keyCaches.set(url, entry);
  }
  return entry;
}

function settings(env) {
  const team = String(env.TEAM_DOMAIN || "");
  const aud = String(env.ACCESS_AUD || "");
  const app = String(env.APP_ORIGIN || "");
  const users = String(env.ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (env.ENABLED !== "true" || !TEAM_DOMAIN.test(team) || !/^[0-9a-f]{64}$/.test(aud) ||
    !APP_ORIGIN.test(app) || !users.length) return null;
  return { team, aud, app, users, upstream: String(env.UPSTREAM_URL || "") };
}

const base64url = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

function loadKeys(entry, url) {
  entry.attempted = Date.now();
  const run = (async () => {
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(KEYS_TIMEOUT),
        cf: { cacheTtl: 300 },
      });
      const body = response.ok ? await response.json() : null;
      if (!Array.isArray(body?.keys)) throw new Error("keys_unavailable");
      entry.keys = body.keys.filter((k) => k?.kty === "RSA" && typeof k.kid === "string");
      entry.fetched = Date.now();
    } catch {
      throw new Error("keys_unavailable");
    }
  })();
  // Cleared after it settles (even if the fetch failed at once), so a later request can try
  // again once KEYS_RETRY has passed.
  entry.pending = run;
  run.catch(() => {}).finally(() => {
    if (entry.pending === run) entry.pending = null;
  });
  return run;
}

async function publicKey(config, kid) {
  const url = `${config.team}/cdn-cgi/access/certs`;
  const entry = keyEntry(url);
  const fresh = () => !!entry.keys && Date.now() - entry.fetched <= KEYS_TTL;
  const find = () => (fresh() ? entry.keys.find((k) => k.kid === kid) : undefined);
  let key = find();
  if (!key) {
    if (entry.pending) await entry.pending;
    else if (Date.now() - entry.attempted >= KEYS_RETRY) await loadKeys(entry, url);
    // Tried too recently: with no usable keys, refuse (503) rather than fetch again.
    else if (!fresh()) throw new Error("keys_unavailable");
    key = find();
  }
  if (!key) return null;
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

// Returns { email, sub } for a valid Access application token, or a reason it is not.
// Throws only when the keys cannot be fetched (the caller answers 503, not "allowed").
export async function verifyAccessToken(token, config, now = Date.now() / 1000) {
  if (typeof token !== "string" || token.length > MAX_TOKEN) return { error: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    return { error: "malformed" };
  let header, claims;
  try {
    header = json(base64url(parts[0]));
    claims = json(base64url(parts[1]));
  } catch {
    return { error: "malformed" };
  }
  if (header?.alg !== "RS256" || typeof header.kid !== "string") return { error: "algorithm" };
  const key = await publicKey(config, header.kid);
  if (!key) return { error: "unknown_key" };
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(parts[2]), signed);
  } catch {
    valid = false;
  }
  if (!valid) return { error: "signature" };
  if (claims?.iss !== config.team) return { error: "issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.aud)) return { error: "audience" };
  // Times are finite numbers: exp is required; nbf and iat, when present, must be too.
  const time = (value) => typeof value === "number" && Number.isFinite(value);
  if (!time(claims.exp) || ("nbf" in claims && !time(claims.nbf)) ||
    ("iat" in claims && !time(claims.iat))) return { error: "claims" };
  if (claims.exp + LEEWAY < now) return { error: "expired" };
  if ("nbf" in claims && claims.nbf - LEEWAY > now) return { error: "not_yet" };
  if ("iat" in claims && claims.iat - LEEWAY > now) return { error: "not_yet" };
  // A user's application token. Service tokens (common_name, no email) are not users.
  if (claims.type !== "app" || typeof claims.email !== "string" || !claims.email ||
    typeof claims.sub !== "string" || !claims.sub) return { error: "not_a_user" };
  const email = claims.email.toLowerCase();
  if (!config.users.includes(email)) return { error: "not_allowed" };
  return { email, sub: claims.sub, exp: claims.exp };
}

const safeHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function corsHeaders(config) {
  return { ...safeHeaders, "Access-Control-Allow-Origin": config.app, "Vary": "Origin" };
}

// Fixed, short error bodies. Never the token, its claims or the key.
const reply = (status, error, headers) =>
  Response.json(error ? { error } : {}, { status, headers });

function handoffPage(config, state, token, exp, nonce) {
  // JSON inside a script: escape "<" so the page cannot be closed early.
  const data = JSON.stringify({ type: "audio-loop-auth", state, token, exp }).replace(/</g, "\\u003c");
  const target = JSON.stringify(config.app);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ログイン</title><p id="m">ログインしました。このウィンドウを閉じています…</p>
<script nonce="${nonce}">
const data = ${data};
if (window.opener) { window.opener.postMessage(data, ${target}); window.close(); }
else document.getElementById("m").textContent = "元の画面に戻れませんでした。このウィンドウを閉じて、アプリからもう一度ログインしてください。";
</script>`;
}

async function handoff(request, config) {
  const state = new URL(request.url).searchParams.get("state") || "";
  if (!STATE.test(state)) return reply(400, "state", safeHeaders);
  // Set by Access on this path. Verified like any other token: if Access were missing or
  // misconfigured, a forged header still fails the signature check.
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const result = await verifyAccessToken(token, config);
  if (!result.email || result.error) return reply(result.error === "not_allowed" ? 403 : 401,
    result.error === "not_allowed" ? "not_allowed" : "unauthenticated", safeHeaders);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return new Response(handoffPage(config, state, token, result.exp, nonce), {
    status: 200,
    headers: {
      ...safeHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "X-Frame-Options": "DENY",
    },
  });
}

async function readJson(request) {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return { status: 415 };
  const reader = request.body?.getReader();
  if (!reader) return { status: 400 };
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return { status: 413 };
    }
    chunks.push(value);
  }
  try {
    return { data: JSON.parse(await new Blob(chunks).text()) };
  } catch {
    return { status: 400 };
  }
}

// Stand-in for a paid API: called only with a verified, allowed identity. The identity
// (sub, email) is what a later usage ledger would be keyed on.
async function callUpstream(config, identity, data, env) {
  if (!/^https:\/\//.test(config.upstream) || !env.UPSTREAM_KEY) return { status: 503, error: "disabled" };
  const response = await fetch(config.upstream, {
    method: "POST",
    redirect: "manual",
    headers: { "Authorization": `Bearer ${env.UPSTREAM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: data.text, user: identity.sub }),
  });
  return response.ok ? null : { status: 502, error: "upstream" };
}

async function api(request, config, env) {
  const headers = corsHeaders(config);
  if (request.headers.get("Origin") !== config.app) return reply(403, "origin", safeHeaders);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    ...headers,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  } });
  if (request.method !== "POST") return reply(405, "method", headers);
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return reply(401, "unauthenticated", headers);
  const result = await verifyAccessToken(token, config);
  if (result.error === "not_allowed") return reply(403, "not_allowed", headers);
  if (result.error) return reply(401, "unauthenticated", headers);
  const body = await readJson(request);
  if (body.status) return reply(body.status, "request", headers);
  if (typeof body.data?.text !== "string" || !body.data.text.trim() || body.data.text.length > 1000)
    return reply(400, "request", headers);
  const failed = await callUpstream(config, result, body.data, env);
  if (failed) return reply(failed.status, failed.error, headers);
  return Response.json({ ok: true }, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const config = settings(env);
    if (!config) return reply(503, "disabled", safeHeaders);
    const path = new URL(request.url).pathname;
    try {
      if (path === "/auth/handoff" && request.method === "GET") return await handoff(request, config);
      if (path.startsWith("/api/")) return await api(request, config, env);
      return reply(404, "not_found", safeHeaders);
    } catch {
      // Keys could not be fetched, or anything unexpected: refuse, and say nothing more.
      return reply(503, "unavailable", path.startsWith("/api/") ? corsHeaders(config) : safeHeaders);
    }
  },
};
