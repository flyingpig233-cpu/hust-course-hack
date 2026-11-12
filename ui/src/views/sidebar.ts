import { esc, toast } from "../dom";
import { icon } from "../icons";
import { platformMeta } from "../platforms";
import type { Platform, SessionInfo } from "../types";

/** One entry in the platform-neutral course list. */
export interface SidebarItem {
  id: string;
  name: string;
  meta: string;
  /** Optional group header (e.g. 共享课 / AI 智课 / 智慧课程 / 其他). */
  group?: string;
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
    platform: "hust",
    courses: [],
    selectedId: null,
    disabled: false,
  };
  let search = "";

  const renderShell = () => {
    const meta = platformMeta(state.platform);
    root.innerHTML = `
      <div class="sidebar-nav">
        <div class="sidebar-nav-head">
          <div class="sidebar-label">${esc(meta.courseListLabel)} <span id="course-count" class="count-pill"></span></div>
          <button class="icon-button icon-button-dark" data-refresh title="刷新课程" aria-label="刷新课程">${icon("refresh", 15)}</button>
        </div>
        <div class="search-box">
          ${icon("search", 15)}
          <input id="course-search" type="search" placeholder="搜索课程" autocomplete="off" spellcheck="false" />
        </div>
        <div class="course-list" id="course-list"></div>
      </div>
      <div class="sidebar-footer">
        <div id="sidebar-session"></div>
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
    if (!session) {
      sessionSlot.innerHTML = "";
      return;
    }
    sessionSlot.innerHTML = `
        <button class="sidebar-link" data-disconnect>${icon(
          "logout",
          15,
        )} 退出登录</button>
    `;
  };

  const renderList = () => {
    countPill.textContent = state.session ? String(state.courses.length) : "";
    list.classList.toggle("is-disabled", state.disabled);

    if (!state.session) {
      list.innerHTML = "";
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
          ? "无匹配课程"
          : "暂无课程",
      )}</p></div>`;
      return;
    }

    let lastGroup = "";
    list.innerHTML = filtered
      .map((course) => {
        const active = course.id === state.selectedId;
        const group = course.group ?? "";
        const header =
          group && group !== lastGroup
            ? `<div class="sidebar-group-label">${esc(group)}</div>`
            : "";
        lastGroup = group;
        return (
          header +
          `
          <button class="course-item${active ? " is-active" : ""}" data-course-id="${esc(
            course.id,
          )}" title="${esc(course.name)}">
            <span class="course-avatar tone-${tone(course.id)}">${esc(
              initial(course.name),
            )}</span>
            <span class="course-copy">
              <span class="course-name">${esc(course.name)}</span>
            </span>
            <span class="course-chevron">${icon("chevron", 14)}</span>
          </button>
        `
        );
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
    const item = target.closest<HTMLElement>("[data-course-id]");
    if (item) {
      if (state.disabled) {
        toast("请先停止当前任务");
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
        // Rebuild the shell so the labels follow the platform.
        renderShell();
        bind();
      }
      renderSession();
      renderList();
    },
  };
}
