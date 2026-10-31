// Shared steps for the practice screen.
import { expect } from "@playwright/test";

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
