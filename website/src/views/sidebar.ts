import { esc, toast } from "../dom";
import { isDemo } from "../env";
import { basename } from "../format";
import { icon } from "../icons";
import type { CourseSummary, SessionInfo } from "../types";

export interface SidebarState {
  session: SessionInfo | null;
  courses: CourseSummary[];
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

export function createSidebar(
  root: HTMLElement,
  handlers: SidebarHandlers,
): SidebarHandle {
  let state: SidebarState = {
    session: null,
    courses: [],
    selectedId: null,
    disabled: false,
  };
  let search = "";

  root.innerHTML = `
    <div class="brand">
      <div class="brand-mark">${icon("book", 20)}</div>
      <div class="brand-copy">
        <div class="brand-name">HUST Course Hack</div>
        <div class="brand-sub">SmartCourse 网页助手</div>
      </div>
    </div>
    ${!isDemo ? "" : `<div class="demo-badge">${icon("spark", 12)} 演示模式</div>`}
    <div id="sidebar-session"></div>
    <div class="sidebar-nav">
      <div class="sidebar-nav-head">
        <div class="sidebar-label">我的课程 <span id="course-count" class="count-pill"></span></div>
        <button class="icon-button icon-button-dark" data-refresh title="刷新课程列表" aria-label="刷新课程列表">${icon("refresh", 15)}</button>
      </div>
      <div class="search-box">
        ${icon("search", 15)}
        <input id="course-search" type="search" placeholder="搜索课程" autocomplete="off" spellcheck="false" />
      </div>
      <div class="course-list" id="course-list"></div>
    </div>
    <div class="sidebar-footer">
      <button class="sidebar-link" data-helper>${icon("copy", 15)} 浏览器助手脚本</button>
      <div class="sidebar-note">${icon("shield", 13)} 登录会话仅保存在内存</div>
    </div>
  `;

  const sessionSlot = root.querySelector<HTMLElement>("#sidebar-session")!;
  const list = root.querySelector<HTMLElement>("#course-list")!;
  const searchInput = root.querySelector<HTMLInputElement>("#course-search")!;
  const countPill = root.querySelector<HTMLElement>("#course-count")!;

  const renderSession = () => {
    const session = state.session;
    if (!session) {
      sessionSlot.innerHTML = `
        <div class="session-card is-idle">
          <span class="status-dot status-dot-idle"></span>
          <div class="session-copy">
            <div class="session-title">未连接</div>
            <div class="session-source">登录学校账号开始</div>
          </div>
        </div>
      `;
      return;
    }
    sessionSlot.innerHTML = `
      <div class="session-card">
        <span class="status-dot"></span>
        <div class="session-copy">
          <div class="session-title">已连接 SmartCourse</div>
          <div class="session-source" title="${esc(session.cookieSource)}">${esc(
            basename(session.cookieSource),
          )}</div>
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
          <p>连接账号后，课程会出现在这里</p>
        </div>
      `;
      return;
    }

    const query = search.trim().toLowerCase();
    const filtered = state.courses.filter((course) => {
      if (!query) return true;
      return (
        course.name.toLowerCase().includes(query) ||
        course.course_id.includes(query) ||
        course.class_id.includes(query)
      );
    });

    if (filtered.length === 0) {
      list.innerHTML = `<div class="sidebar-placeholder"><p>${
        state.courses.length ? "没有匹配的课程" : "当前账号没有课程"
      }</p></div>`;
      return;
    }

    list.innerHTML = filtered
      .map((course) => {
        const active = course.course_id === state.selectedId;
        return `
          <button class="course-item${active ? " is-active" : ""}" data-course-id="${esc(
            course.course_id,
          )}" title="${esc(course.name)}">
            <span class="course-avatar tone-${tone(course.course_id)}">${esc(
              initial(course.name),
            )}</span>
            <span class="course-copy">
              <span class="course-name">${esc(course.name)}</span>
              <span class="course-meta">${esc(course.course_id)}</span>
            </span>
            <span class="course-chevron">${icon("chevron", 14)}</span>
          </button>
        `;
      })
      .join("");
  };

  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    renderList();
  });

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
        toast("正在抓取课程，请先取消当前任务");
        return;
      }
      handlers.onSelect(item.dataset.courseId ?? "");
    }
  });

  return {
    update(next) {
      state = next;
      renderSession();
      renderList();
    },
  };
}
