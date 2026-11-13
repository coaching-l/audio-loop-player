// Browser side of the verification (not loaded by the app yet).
// The Access token lives only in this module's memory: not in localStorage, cookies, the
// URL or the Service Worker cache. Reloading the page forgets it; signing in again is
// quick while the Access session lasts (no new PIN).

const randomState = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function createAuthClient({ apiOrigin, timeout = 5 * 60 * 1000 }) {
  let session = null; // { token, exp }
  const signedIn = () => !!session && session.exp * 1000 > Date.now() + 30000;

  // Must run from a tap or click, or the browser blocks the window.
  function signIn() {
    const state = randomState();
    const popup = window.open(
      `${apiOrigin}/auth/handoff?state=${state}`,
      "audio-loop-sign-in",
      "popup,width=480,height=640",
    );
    if (!popup) return Promise.reject(new Error("popup_blocked"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("timeout")), timeout);
      function finish(error) {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (error) reject(error);
        else resolve();
      }
      function onMessage(event) {
        // Only the sign-in window we opened, from the API's exact origin, for this attempt.
        if (event.origin !== apiOrigin || event.source !== popup) return;
        const data = event.data;
        if (data?.type !== "audio-loop-auth" || data.state !== state) return;
        if (typeof data.token !== "string" || typeof data.exp !== "number") return;
        session = { token: data.token, exp: data.exp };
        finish();
      }
      window.addEventListener("message", onMessage);
    });
  }

  function signOut() {
    session = null;
  }

  async function call(path, body) {
    if (!signedIn()) throw new Error("sign_in_required");
    const response = await fetch(`${apiOrigin}${path}`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Authorization": `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 401) session = null;
    return response;
  }

  return { signIn, signOut, call, signedIn };
}
