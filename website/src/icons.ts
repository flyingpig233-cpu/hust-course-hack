// Inline stroke icons; no icon font or external assets.
const paths: Record<string, string> = {
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3V9Z"/>',
  document: '<path d="M14 3v5h5"/><path d="M6 3h8l5 5v13H6V3Z"/><path d="M9 13h6M9 17h4"/>',
  work: '<path d="M9 4h6v3H9z"/><path d="M7 5H5v16h14V5h-2"/><path d="m8.5 13 2 2 4.5-4.5"/>',
  audio: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><path d="M4 14a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2Z"/><path d="M20 14a2 2 0 0 0-2 2v2a2 2 0 0 0 4 0v-2a2 2 0 0 0-2-2Z"/>',
  live: '<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17"/>',
  other: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6M9 13h6M9 17h3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  alert: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 9v5M12 17h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6"/>',
  shield: '<path d="M12 3 5 6v6c0 4.4 3 7.5 7 9 4-1.5 7-4.6 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/>',
  save: '<path d="M5 4h11l3 3v13H5V4Z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  logout: '<path d="M9 5H5v14h4"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>',
  spark: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  settings:
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};

export function icon(name: keyof typeof paths, size = 16): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    paths[name] ?? paths.other
  }</svg>`;
}
