export async function pickSavePath(defaultPath: string, _name: string, _extensions: string[]): Promise<string | null> { return defaultPath; }
export async function openExternal(url: string): Promise<void> {
  const target = new URL(url, location.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('只允许打开 HTTP/HTTPS 链接');
  window.open(target.href, '_blank', 'noopener,noreferrer');
}
export function downloadText(name: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
