import { esc, toast } from "../dom";
import { isTauri } from "../env";
import { icon } from "../icons";
import { platformMeta } from "../platforms";
import type { Platform, SessionInfo } from "../types";

/** One entry in the platform-neutral course list. */
export interface SidebarItem {
  id: string;
  name: string;
  meta: string;
}

export interface SidebarState {
  session: SessionInfo | null;
  /** Selected platform on the connect screen; also drives the idle copy. */
  platform: Platform;
  courses: SidebarItem[];
  selectedId: string | null;
  disabled: boolean;
}

export interface SidebarHandlers {
  onSelect(courseId: string): void;
  onRefreshCourses(): void;
  onDisconnect(): void;
  onHelper(): void;
}

export interface SidebarHandle {
  update(state: SidebarState): void;
}

function initial(name: string): string {
  return [...name.trim()][0] ?? "课";
}

function tone(id: string): number {
  let sum = 0;
  for (const char of id) sum += char.charCodeAt(0);
  return sum % 5;
}

/** Idle / empty list hint per platform. */
function listHint(platform: Platform, connected: boolean): string {
  if (!connected) return `${platformMeta(platform).idleHint}`;
  switch (platform) {
    case "zhihuishu":
      return "没有解析到共享课，可在课程页粘贴学习页链接添加";
    case "ulearning":
      return "没有解析到课程，可在课程页粘贴播放器链接添加";
    default:
      return "当前账号没有课程";
  }
}

function placeholderHint(platform: Platform): string {
  switch (platform) {
    case "zhihuishu":
      return "连接知到后，共享课会出现在这里";
    case "ulearning":
      return "连接优学院后，课程会出现在这里";
    default:
      return "连接账号后，课程会出现在这里";
  }
}

export function createSidebar(
  root: HTMLElement,
  handlers: SidebarHandlers,
): SidebarHandle {
  let state: SidebarState = {
    session: null,
    platform: "hust",
    courses: [],
    selectedId: null,
    disabled: false,
  };
  let search = "";

  const renderShell = () => {
    const meta = platformMeta(state.platform);
    root.innerHTML = `
      <div class="brand">
        <div class="brand-mark">${icon("book", 20)}</div>
        <div class="brand-copy">
          <div class="brand-name">HUST Course Hack</div>
          <div class="brand-sub">${esc(meta.brandSub)}</div>
        </div>
      </div>
      ${isTauri ? "" : `<div class="demo-badge">${icon("spark", 12)} 演示模式</div>`}
      <div id="sidebar-session"></div>
      <div class="sidebar-nav">
        <div class="sidebar-nav-head">
          <div class="sidebar-label">${esc(meta.courseListLabel)} <span id="course-count" class="count-pill"></span></div>
          <button class="icon-button icon-button-dark" data-refresh title="刷新课程列表" aria-label="刷新课程列表">${icon("refresh", 15)}</button>
        </div>
        <div class="search-box">
          ${icon("search", 15)}
          <input id="course-search" type="search" placeholder="搜索课程" autocomplete="off" spellcheck="false" />
        </div>
        <div class="course-list" id="course-list"></div>
      </div>
      <div class="sidebar-footer">
        ${
          state.platform === "hust"
            ? `<button class="sidebar-link" data-helper>${icon("copy", 15)} 浏览器助手脚本</button>`
            : ""
        }
        <div class="sidebar-note">${icon("shield", 13)} 登录会话仅保存在内存</div>
      </div>
    `;
  };

  renderShell();
  let sessionSlot = root.querySelector<HTMLElement>("#sidebar-session")!;
  let list = root.querySelector<HTMLElement>("#course-list")!;
  let countPill = root.querySelector<HTMLElement>("#course-count")!;
  let searchInput = root.querySelector<HTMLInputElement>("#course-search")!;

  const renderSession = () => {
    const session = state.session;
    const meta = platformMeta(session?.platform ?? state.platform);
    if (!session) {
      sessionSlot.innerHTML = `
        <div class="session-card is-idle">
          <span class="status-dot status-dot-idle"></span>
          <div class="session-copy">
            <div class="session-title">未连接</div>
            <div class="session-source">${esc(meta.idleHint)}</div>
          </div>
        </div>
      `;
      return;
    }
    sessionSlot.innerHTML = `
      <div class="session-card">
        <span class="status-dot"></span>
        <div class="session-copy">
          <div class="session-title">已连接 ${esc(meta.sessionTitle)}</div>
          <div class="session-source" title="${esc(session.cookieSource)}">${esc(
            session.cookieSource,
          )} · ${session.cookieCount} 项 Cookie</div>
        </div>
        <button class="icon-button icon-button-dark" data-disconnect title="断开连接" aria-label="断开连接">${icon(
          "logout",
          15,
        )}</button>
      </div>
    `;
  };

  const renderList = () => {
    countPill.textContent = state.session ? String(state.courses.length) : "";
    list.classList.toggle("is-disabled", state.disabled);

    if (!state.session) {
      list.innerHTML = `
        <div class="sidebar-placeholder">
          <div class="sidebar-placeholder-icon">${icon("folder", 20)}</div>
          <p>${esc(placeholderHint(state.platform))}</p>
        </div>
      `;
      return;
    }

    const query = search.trim().toLowerCase();
    const filtered = state.courses.filter((course) => {
      if (!query) return true;
      return (
        course.name.toLowerCase().includes(query) ||
        course.meta.toLowerCase().includes(query) ||
        course.id.includes(query)
      );
    });

    if (filtered.length === 0) {
      list.innerHTML = `<div class="sidebar-placeholder"><p>${esc(
        state.courses.length
          ? "没有匹配的课程"
          : listHint(state.platform, true),
      )}</p></div>`;
      return;
    }

    list.innerHTML = filtered
      .map((course) => {
        const active = course.id === state.selectedId;
        return `
          <button class="course-item${active ? " is-active" : ""}" data-course-id="${esc(
            course.id,
          )}" title="${esc(course.name)}">
            <span class="course-avatar tone-${tone(course.id)}">${esc(
              initial(course.name),
            )}</span>
            <span class="course-copy">
              <span class="course-name">${esc(course.name)}</span>
              <span class="course-meta">${esc(course.meta)}</span>
            </span>
            <span class="course-chevron">${icon("chevron", 14)}</span>
          </button>
        `;
      })
      .join("");
  };

  const bind = () => {
    sessionSlot = root.querySelector<HTMLElement>("#sidebar-session")!;
    list = root.querySelector<HTMLElement>("#course-list")!;
    countPill = root.querySelector<HTMLElement>("#course-count")!;
    searchInput = root.querySelector<HTMLInputElement>("#course-search")!;
    searchInput.value = search;
    searchInput.addEventListener("input", () => {
      search = searchInput.value;
      renderList();
    });
  };

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-refresh]")) {
      handlers.onRefreshCourses();
      return;
    }
    if (target.closest("[data-disconnect]")) {
      handlers.onDisconnect();
      return;
    }
    if (target.closest("[data-helper]")) {
      handlers.onHelper();
      return;
    }
    const item = target.closest<HTMLElement>("[data-course-id]");
    if (item) {
      if (state.disabled) {
        toast("正在执行任务，请先取消当前任务");
        return;
      }
      handlers.onSelect(item.dataset.courseId ?? "");
    }
  });

  return {
    update(next) {
      const platformChanged = next.platform !== state.platform;
      state = next;
      if (platformChanged) {
        // Rebuild the shell so the labels and helper link follow the platform.
        renderShell();
        bind();
      }
      renderSession();
      renderList();
    },
  };
}
