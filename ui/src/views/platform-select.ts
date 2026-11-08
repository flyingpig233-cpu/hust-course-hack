// Shared three-platform selector used by the connect screen.
import { PLATFORM_ORDER, platformMeta } from "../platforms";
import type { Platform } from "../types";

/** Markup for the platform switch group. */
export function platformSwitchHtml(active: Platform, busy: boolean): string {
  return `
    <div class="platform-switch" role="group" aria-label="选择平台">
      ${PLATFORM_ORDER.map((platform) => {
        const meta = platformMeta(platform);
        return `
          <button class="platform-option${active === platform ? " is-active" : ""}" data-platform="${platform}"${
            busy ? " disabled" : ""
          }>
            <span class="platform-mark">${meta.mark}</span>
            <span>${meta.label}</span>
          </button>`;
      }).join("")}
    </div>
  `;
}

/** Wire the platform switch buttons inside `root`. */
export function bindPlatformSwitch(
  root: ParentNode,
  busy: boolean,
  onSelect: (platform: Platform) => void,
): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-platform]",
  )) {
    button.addEventListener("click", () => {
      if (busy) return;
      const platform = button.dataset.platform as Platform | undefined;
      if (platform) onSelect(platform);
    });
  }
}
