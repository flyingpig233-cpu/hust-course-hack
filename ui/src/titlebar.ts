import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorText, qs, toast } from "./dom";
import { isTauri } from "./env";

/** Window controls are only available in the desktop main window. */
export function initTitlebar(): void {
  if (!isTauri) return;

  const window = getCurrentWindow();
  const maximize = qs<HTMLButtonElement>("#window-maximize");
  const reportError = (error: unknown) => toast(`窗口操作失败：${errorText(error)}`, "error");
  const updateMaximized = async () => {
    const maximized = await window.isMaximized();
    maximize.classList.toggle("is-maximized", maximized);
    const label = maximized ? "还原" : "最大化";
    maximize.title = label;
    maximize.setAttribute("aria-label", label);
  };

  qs<HTMLButtonElement>("#window-minimize").addEventListener("click", () => {
    void window.minimize().catch(reportError);
  });
  maximize.addEventListener("click", () => {
    void window.toggleMaximize().then(updateMaximized).catch(reportError);
  });
  qs<HTMLButtonElement>("#window-close").addEventListener("click", () => {
    void window.close().catch(reportError);
  });
  void updateMaximized().catch(reportError);
  void window.onResized(() => { void updateMaximized().catch(reportError); }).catch(reportError);
}
