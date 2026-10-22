export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function qs<T extends Element>(
  selector: string,
  root: ParentNode = document,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}

export type ToastTone = "info" | "success" | "error";

export function toast(message: string, tone: ToastTone = "info"): void {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast toast-${tone}`;
  node.textContent = message;
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add("is-visible"));
  window.setTimeout(() => {
    node.classList.remove("is-visible");
    window.setTimeout(() => node.remove(), 220);
  }, tone === "error" ? 6000 : 3600);
}

export function spinner(size = ""): string {
  return `<span class="spinner ${size}"></span>`;
}

export async function withButtonBusy<T>(
  button: HTMLButtonElement,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const original = button.innerHTML;
  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = `${spinner("spinner-sm")}<span>${esc(label)}</span>`;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.innerHTML = original;
  }
}

export function openModal(
  content: HTMLElement,
  options: { wide?: boolean; onClose?: () => void } = {},
): () => void {
  const root = document.getElementById("modal-root");
  if (!root) return () => undefined;

  let closed = false;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const panel = document.createElement("div");
  panel.className = `modal${options.wide ? " modal-wide" : ""}`;
  panel.appendChild(content);
  backdrop.appendChild(panel);
  root.appendChild(backdrop);

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    backdrop.classList.remove("is-open");
    window.setTimeout(() => backdrop.remove(), 180);
    options.onClose?.();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  requestAnimationFrame(() => backdrop.classList.add("is-open"));
  return close;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
