import { esc, qs, spinner } from "../dom";
import { isTauri } from "../env";
import { icon } from "../icons";
import { platformMeta } from "../platforms";
import type { CourseSummary, Platform, SessionInfo } from "../types";
import { bindPlatformSwitch, platformSwitchHtml } from "./platform-select";

export type LoginStatus = "idle" | "opening" | "waiting" | "failed";

export interface ConnectHandlers {
  platform: Platform;
  status: LoginStatus;
  error: string | null;
  onPlatformChange(platform: Platform): void;
  onLogin(): void;
}

export function renderConnect(main: HTMLElement, handlers: ConnectHandlers): void {
  renderDesktopConnect(main, handlers);
}

function renderDesktopConnect(main: HTMLElement, handlers: ConnectHandlers): void {
  main.onclick = null;
  main.onchange = null;
  const meta = platformMeta(handlers.platform);
  const busy = handlers.status === "opening" || handlers.status === "waiting";
  const buttonLabel =
    handlers.status === "opening"
      ? meta.openingLabel
      : handlers.status === "waiting"
        ? "等待登录…"
        : handlers.status === "failed"
          ? meta.retryButton
          : meta.loginButton;

  main.innerHTML = `
    <section class="connect-view">
      <div class="connect-card">
        <div class="connect-card-head">
          <h1>登录</h1>
        </div>
        ${platformSwitchHtml(handlers.platform, busy)}
        <div class="login-panel">
          <button class="btn btn-primary btn-lg" id="login-button" ${busy ? "disabled" : ""}>
            ${busy ? spinner("spinner-sm") : icon("user", 17)}
            <span>${buttonLabel}</span>
          </button>
          ${handlers.error ? `<div class="connect-error is-visible">${esc(handlers.error)}</div>` : ""}
        </div>
        ${isTauri ? "" : `<div class="demo-notice">${icon("spark", 15)} 演示模式</div>`}
      </div>
    </section>
  `;

  bindPlatformSwitch(main, busy, handlers.onPlatformChange);
  qs<HTMLButtonElement>("#login-button", main).addEventListener("click", () =>
    handlers.onLogin(),
  );
}

export function renderHome(
  main: HTMLElement,
  _session: SessionInfo,
  courses: CourseSummary[],
  handlers: { onSelect(id: string): void; onRefreshCourses(): void },
): void {
  main.innerHTML = `
    <section class="home-view">
      <header class="home-head">
        <div>
          <h1>我的课程</h1>
          <p class="home-sub">${courses.length} 门课程</p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-refresh>${icon("refresh", 15)} 刷新课程</button>
        </div>
      </header>

      ${
        courses.length
          ? `<div class="course-grid">${courses
              .map((course, index) => {
                const initial = [...course.name.trim()][0] ?? "课";
                let sum = 0;
                for (const char of course.course_id) sum += char.charCodeAt(0);
                return `
                  <button class="course-card" data-course-id="${esc(
                    course.course_id,
                  )}" style="--delay:${index * 30}ms">
                    <div class="course-card-top">
                      <span class="course-avatar course-avatar-lg tone-${sum % 5}">${esc(
                        initial,
                      )}</span>
                    </div>
                    <h3>${esc(course.name)}</h3>
                  </button>
                `;
              })
              .join("")}</div>`
          : `<div class="empty-panel">
              <div class="empty-icon">${icon("folder", 26)}</div>
              <h2>暂无课程</h2>
            </div>`
      }

    </section>
  `;

  main.onclick = (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-refresh]")) {
      handlers.onRefreshCourses();
      return;
    }
    const card = target.closest<HTMLElement>("[data-course-id]");
    if (card) handlers.onSelect(card.dataset.courseId ?? "");
  };
}
