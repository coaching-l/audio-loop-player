// Shared steps for the practice screen.
import { test, expect } from "@playwright/test";

// Opens the folded "詳しい設定" so its fields can be used.
export async function openAdvanced(page) {
  const details = page.locator("#advanced");
  if (!(await details.evaluate((d) => d.open)))
    await details.locator("summary").click();
}

// Turns interval repeat on or off with the button above the gauge.
export async function setRepeat(page, on) {
  const toggle = page.locator("#toggle-ab");
  if ((await toggle.getAttribute("aria-pressed")) !== String(on))
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(on));
}

// Linux WebKit (the CI's WebKit) cannot run some offline steps: once the network is cut
// it reports "WebKit encountered an internal error" on navigation, or cannot re-read a
// Blob (NotReadableError). Offline use was checked on a real iPhone. These tests still
// run everywhere; on Linux WebKit they are expected to fail, so the WebKit job turns red
// only for a new failure, or if one of these starts to pass. See DEVELOPMENT.md.
export function expectLinuxWebKitFailure(browserName, reason) {
  test.fail(browserName === "webkit" && process.platform === "linux", reason);
}

