// Shared by the entry (app.js) and the practice screen (practice.js): messages and undo.
export const $ = (id) => document.getElementById(id);

// Once storage has failed, that warning stays on screen instead of routine messages.
let storageWarning = false;
export function notice(message) {
  $("notice").textContent = message;
}
export function routineNotice(message) {
  if (!storageWarning) notice(message);
}
export function storageProblem(message) {
  storageWarning = true;
  notice(message);
}
export function error(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

// One deletion at a time can be undone; a newer deletion or switching audio settles the older one.
let undo = null;
export function settleUndo() {
  if (!undo) return;
  clearTimeout(undo.timer);
  undo = null;
  $("undo-bar").hidden = true;
}
export function offerUndo(message, revert) {
  settleUndo();
  $("undo-message").textContent = message;
  $("undo-bar").hidden = false;
  undo = { revert, timer: setTimeout(settleUndo, 10000) };
}
$("undo-button").addEventListener("click", () => {
  const revert = undo?.revert;
  settleUndo();
  void revert?.();
});
