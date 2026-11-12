// Shared course-page shell: header, notice banner and stat strip. Used by the
// Zhihuishu and Ulearning course views so the two do not clone markup.
import { esc } from "../dom";
import type { IconName } from "../icons";
import { icon } from "../icons";

export interface CourseHeadOptions {
  title: string;
  subtitle: string;
  /** Pre-rendered action buttons. */
  actions: string;
}

/** `<header class="course-head">` block with title and action buttons. */
export function courseHeadHtml(options: CourseHeadOptions): string {
  return `
    <header class="course-head">
      <div class="course-head-copy">
        <h1>${esc(options.title)}</h1>
        ${options.subtitle ? `<p class="course-sub">${esc(options.subtitle)}</p>` : ""}
      </div>
      <div class="head-actions">${options.actions}</div>
    </header>
  `;
}

/** Warning/info banner used above the course tree. */
export function noticeHtml(
  iconName: IconName,
  body: string,
  warn = true,
): string {
  return `
    <div class="inline-notice${warn ? " notice-warn" : ""}">
      ${icon(iconName, 14)} ${body}
    </div>
  `;
}

export interface StatCard {
  label?: string;
  value: string;
  foot?: string;
  /** Renders as the wide card with a progress bar. */
  wide?: boolean;
  /** Progress percentage for a wide card. */
  progress?: number;
}

/** Stat strip (`stat-strip` + `stat-card`) used by the platform course pages. */
export function statStripHtml(cards: StatCard[]): string {
  return `
    <div class="stat-strip">
      ${cards
        .map((card) =>
          card.wide
            ? `
        <div class="stat-card stat-card-wide">
          <div class="stat-head"><span>${esc(card.label ?? "")}</span><strong>${esc(
            card.value,
          )}</strong></div>
          <div class="progress"><div class="progress-fill fill-good" style="width:${Math.max(
            0,
            Math.min(100, card.progress ?? 0),
          )}%"></div></div>
          ${card.foot ? `<div class="stat-foot">${esc(card.foot)}</div>` : ""}
        </div>`
            : `
        <div class="stat-card">
          ${card.label ? `<span class="stat-label">${esc(card.label)}</span>` : ""}
          <strong>${esc(card.value)}</strong>
          ${card.foot ? `<span class="stat-foot">${esc(card.foot)}</span>` : ""}
        </div>`,
        )
        .join("")}
    </div>
  `;
}
