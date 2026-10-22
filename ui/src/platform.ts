import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./env";

export async function pickSavePath(
  defaultPath: string,
  name: string,
  extensions: string[],
): Promise<string | null> {
  if (!isTauri) return defaultPath;
  return save({
    title: "保存文件",
    defaultPath,
    filters: [{ name, extensions }],
  });
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await openUrl(url);
}
