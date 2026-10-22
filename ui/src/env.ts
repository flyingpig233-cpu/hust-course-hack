/// True when the page runs inside a Tauri webview. Outside Tauri (plain
/// `npm run dev` or a static build opened in a browser) the app uses the
/// built-in demo backend so the UI can be developed and reviewed.
export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
