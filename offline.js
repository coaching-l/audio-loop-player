const status = document.getElementById("offline-status");
const retry = document.getElementById("offline-retry");
const update = document.getElementById("offline-update");
let registration,
  checking = 0,
  reloadForUpdate = false;
let cachedReady = false;
const badge = document.getElementById("help-badge");
function showUpdate(available) {
  update.hidden = !available;
  if (badge) badge.hidden = !available;
}
function unavailable() {
  cachedReady = false;
  status.textContent =
    "オフライン準備が完了していません。オンラインで「準備をやり直す」を押してください。";
  retry.hidden = false;
}
async function workerStatus(type = "OFFLINE_STATUS") {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("timeout"));
    }, 15000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data.ready);
    };
    registration.active.postMessage({ type }, [channel.port2]);
  });
}
async function check() {
  const checkId = ++checking;
  if (!registration?.active) return;
  try {
    const ready = await workerStatus();
    if (checkId !== checking) return;
    if (!ready) {
      unavailable();
      return;
    }
    cachedReady = true;
    retry.hidden = true;
    status.textContent = navigator.onLine
      ? "オフライン準備完了"
      : "オフラインで利用中";
    showUpdate(Boolean(registration.waiting));
  } catch {
    if (checkId === checking) unavailable();
  }
}
function watch(worker) {
  if (!worker) return;
  worker.addEventListener("statechange", () => {
    if (worker.state === "activated") void check();
    if (worker.state === "installed" && registration.active) {
      showUpdate(true);
      void check();
    }
    if (worker.state === "redundant" && !registration.active) unavailable();
  });
}
async function prepare() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    status.textContent =
      "このブラウザ・接続ではオフライン起動を準備できません。HTTPSの公開ページでお試しください。";
    retry.hidden = true;
    return;
  }
  retry.hidden = true;
  status.textContent =
    "オフライン利用を準備中です。この画面を閉じずにお待ちください。";
  try {
    registration = await navigator.serviceWorker.register(
      new URL("./sw.js", import.meta.url),
      {
        scope: new URL("./", import.meta.url).pathname,
        updateViaCache: "none",
      },
    );
    registration.addEventListener("updatefound", () =>
      watch(registration.installing),
    );
    watch(registration.installing);
    if (registration.waiting) showUpdate(true);
    if (registration.active) await check();
    if (
      !registration.active &&
      !registration.installing &&
      !registration.waiting
    )
      unavailable();
  } catch {
    unavailable();
  }
}
retry.addEventListener("click", async () => {
  // Removing a broken registration with no active worker allows a fresh install.
  if (registration && !registration.active) await registration.unregister();
  await prepare();
  if (registration?.active) {
    try {
      await registration.update();
    } catch {
      /* Cached version can still work offline. */
    }
    if (!cachedReady) {
      try {
        await workerStatus("PREPARE_OFFLINE");
      } catch {
        /* Report readiness below. */
      }
    }
    await check();
  }
});
update.addEventListener("click", () => {
  if (!registration?.waiting) return;
  if (!navigator.onLine) {
    status.textContent =
      "更新はオンラインに戻ってから行ってください。現在の版で練習できます。";
    return;
  }
  // Give the app a chance to save the current position before replacing the page.
  window.dispatchEvent(new Event("offline-update"));
  reloadForUpdate = true;
  registration.waiting.postMessage({ type: "ACTIVATE_UPDATE" });
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadForUpdate) location.reload();
    else void check();
  });
window.addEventListener("online", () => void check());
window.addEventListener("offline", () => void check());
void prepare();
