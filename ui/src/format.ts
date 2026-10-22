import type { TaskKind } from "./types";

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

export function formatPercent(done: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "course";
}

export function kindLabel(kind: TaskKind): string {
  switch (kind) {
    case "video":
      return "视频";
    case "document":
      return "文档";
    case "work":
      return "测验";
    case "audio":
      return "音频";
    case "live":
      return "直播";
    default:
      return "其他";
  }
}

export function workStatusLabel(status: string | undefined): string | null {
  if (status === "graded") return "已批改";
  if (status === "submitted") return "已提交";
  if (status === "in_progress") return "作答页";
  return null;
}

/** Extract option labels from an answer such as "A,B" or "A、C". */
export function answerLabels(answer: string | null | undefined): string[] {
  if (!answer) return [];
  const matches = answer.toUpperCase().match(/\b[A-H]\b/g);
  if (matches && matches.length > 0) return [...new Set(matches)];
  const compact = answer.toUpperCase().replace(/[\s,;，、]/g, "");
  if (compact.length > 0 && /^[A-H]+$/.test(compact)) return [...compact];
  return [];
}

export function isAnswerSelected(
  optionLabel: string,
  optionText: string,
  answer: string | null | undefined,
): boolean {
  if (!answer) return false;
  const labels = answerLabels(answer);
  if (labels.length > 0) return labels.includes(optionLabel.toUpperCase());
  return answer.trim() === optionText.trim();
}

export function chapterNumber(number: string | null | undefined): string {
  return number?.trim() || "";
}
