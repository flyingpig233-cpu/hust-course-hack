import { backendMode } from "../api";
import { getStoredAccessToken, webSetAccessToken } from "../api-web";
import { esc, qs, spinner } from "../dom";
import { isTauri } from "../env";
import { basename } from "../format";
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
  /** Web only: the server expects a shared access passcode. */
  tokenRequired?: boolean;
}

export function renderConnect(main: HTMLElement, handlers: ConnectHandlers): void {
  if (backendMode === "web") {
    renderWebConnect(main, handlers);
    return;
  }
  renderDesktopConnect(main, handlers);
}

function featureCards(): string {
  return `
    <div class="feature-card">
      <div class="feature-icon tone-blue">${icon("folder", 20)}</div>
      <h3>课程结构一目了然</h3>
      <p>章 / 节 / 知识点三级树，视频、文档、测验任务点与完成状态集中在同一页。</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon tone-violet">${icon("work", 20)}</div>
      <h3>测验答案与得分</h3>
      <p>已批改作业展示正确答案、我的答案与得分；未批改作业只显示题目。</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon tone-green">${icon("video", 20)}</div>
      <h3>视频进度上报</h3>
      <p>复现播放器心跳，支持整门课或单个视频；每次运行重新获取签名，不保存 dtoken。</p>
    </div>
  `;
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
        ? "等待登录完成…"
        : handlers.status === "failed"
          ? meta.retryButton
          : meta.loginButton;

  main.innerHTML = `
    <section class="connect-view">
      <div class="connect-hero">
        ${platformSwitchHtml(handlers.platform, busy)}

        <div class="eyebrow">${esc(meta.eyebrow)}</div>
        <h1>${meta.title}</h1>
        <p class="connect-lead">${esc(meta.lead)}</p>

        ${
          isTauri
            ? ""
            : `<div class="demo-notice">${icon("spark", 15)} 演示模式：点击登录会模拟一次${esc(
                meta.demoLogin,
              )}登录，并加载内置示例课程。</div>`
        }

        <div class="connect-card">
          <div class="connect-card-head">
            <span class="connect-step">1</span>
            <div>
              <h2>${esc(meta.loginTitle)}</h2>
              <p>${esc(meta.loginHint)}</p>
            </div>
          </div>
          <button class="btn btn-primary btn-lg" id="login-button" ${busy ? "disabled" : ""}>
            ${busy ? spinner("spinner-sm") : icon("user", 17)}
            <span>${buttonLabel}</span>
          </button>
          ${
            busy
              ? `<div class="login-wait"><span class="pulse-dot"></span> 请在新窗口完成登录，成功后会自动返回这里。</div>`
              : ""
          }
          ${
            handlers.error
              ? `<div class="connect-error is-visible">${esc(handlers.error)}</div>`
              : ""
          }
        </div>

        <ol class="connect-steps">
          <li><span>2</span> 在登录窗口完成账号密码 / 二次验证</li>
          <li><span>3</span> ${esc(meta.step3)}</li>
        </ol>
      </div>

      <aside class="connect-aside">
        ${meta.features
          .map(
            (feature) => `
          <div class="feature-card">
            <div class="feature-icon ${feature.tone}">${icon(feature.icon, 20)}</div>
            <h3>${esc(feature.title)}</h3>
            <p>${feature.body}</p>
          </div>`,
          )
          .join("")}
        <div class="security-card">
          <div class="security-head">${icon("shield", 16)} ${esc(meta.securityTitle)}</div>
          <ul>
            ${meta.securityItems.map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </div>
      </aside>
    </section>
  `;

  bindPlatformSwitch(main, busy, handlers.onPlatformChange);
  qs<HTMLButtonElement>("#login-button", main).addEventListener("click", () =>
    handlers.onLogin(),
  );
}

function renderWebConnect(main: HTMLElement, handlers: ConnectHandlers): void {
  main.onclick = null;
  main.onchange = null;
  const busy = handlers.status === "opening" || handlers.status === "waiting";
  const buttonLabel =
    handlers.status === "failed" ? "重新打开登录窗口" : "打开 HUST 登录窗口";
  const savedAccess = getStoredAccessToken();

  main.innerHTML = `
    <section class="connect-view">
      <div class="connect-hero">
        <div class="eyebrow">HUST · 统一身份认证 · 网页版</div>
        <h1>用学校账号<br />登录课程助手</h1>
        <p class="connect-lead">
          点击登录后会在新窗口打开学校统一身份认证页面（官方页面，由服务器安全中转）。
          登录成功后自动读取本次会话并关闭窗口，不需要复制 Cookie，也不需要油猴脚本。
        </p>

        <div class="connect-card">
          <div class="connect-card-head">
            <span class="connect-step">1</span>
            <div>
              <h2>统一身份认证</h2>
              <p>账号密码只在学校官方页面输入，本站不会接触</p>
            </div>
          </div>
          ${
            handlers.tokenRequired
              ? `<div class="connect-web-form">
                  <label class="field">
                    <span>访问口令</span>
                    <input id="access-input" type="password" autocomplete="off" spellcheck="false"
                      placeholder="本站访问口令" value="${esc(savedAccess)}" />
                    <em>口令只保存在本机浏览器，用于调用本站接口</em>
                  </label>
                </div>`
              : ""
          }
          <button class="btn btn-primary btn-lg" id="login-button" ${busy ? "disabled" : ""}>
            ${busy ? spinner("spinner-sm") : icon("user", 17)}
            <span>${
              handlers.status === "opening"
                ? "正在打开登录窗口…"
                : handlers.status === "waiting"
                  ? "等待登录完成…"
                  : buttonLabel
            }</span>
          </button>
          ${
            busy
              ? `<div class="login-wait"><span class="pulse-dot"></span> 请在新窗口完成登录，成功后会自动返回这里。</div>`
              : ""
          }
          ${
            handlers.error
              ? `<div class="connect-error is-visible">${esc(handlers.error)}</div>`
              : ""
          }
        </div>

        <ol class="connect-steps">
          <li><span>2</span> 在登录窗口完成账号密码 / 二次验证</li>
          <li><span>3</span> 自动读取会话并加载课程列表</li>
        </ol>
      </div>

      <aside class="connect-aside">
        ${featureCards()}
        <div class="security-card">
          <div class="security-head">${icon("shield", 16)} 安全说明</div>
          <ul>
            <li>登录窗口加载的是学校官方认证页面，服务器只中转 <code>*.hust.edu.cn</code>。</li>
            <li>账号密码只提交给学校服务器，统一认证页面的加密由官方脚本完成。</li>
            <li>会话只保存在服务器内存中，不写盘，服务重启后需重新登录。</li>
            <li>访问口令保护全部 API 接口，完成结果以服务端 <code>isPassed</code> 为准。</li>
          </ul>
        </div>
      </aside>
    </section>
  `;

  const accessInput = main.querySelector<HTMLInputElement>("#access-input");
  if (accessInput) {
    accessInput.addEventListener("input", () =>
      webSetAccessToken(accessInput.value),
    );
  }
  qs<HTMLButtonElement>("#login-button", main).addEventListener("click", () =>
    handlers.onLogin(),
  );
}

export function renderHome(
  main: HTMLElement,
  session: SessionInfo,
  courses: CourseSummary[],
  handlers: { onSelect(id: string): void; onRefreshCourses(): void; onHelper(): void },
): void {
  main.innerHTML = `
    <section class="home-view">
      <header class="home-head">
        <div>
          <div class="eyebrow">已连接 SmartCourse</div>
          <h1>选择一门课程开始</h1>
          <p class="home-sub">
            当前账号共 ${courses.length} 门课程 ·
            ${esc(basename(session.cookieSource))} 会话包含 ${session.cookieCount} 项 Cookie
          </p>
        </div>
        <div class="head-actions">
          ${backendMode === "web" ? "" : `<button class="btn btn-ghost" data-helper>${icon("copy", 15)} 助手脚本</button>`}
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
                      <span class="course-code">${esc(course.course_id)}</span>
                    </div>
                    <h3>${esc(course.name)}</h3>
                    <p class="course-card-meta">班级 ${esc(course.class_id)}</p>
                    <span class="course-card-cta">加载课程目录 ${icon("chevron", 14)}</span>
                  </button>
                `;
              })
              .join("")}</div>`
          : `<div class="empty-panel">
              <div class="empty-icon">${icon("folder", 26)}</div>
              <h2>当前账号没有课程</h2>
              <p>登录已成功，但本学期课程列表为空；也可能需要稍后刷新。</p>
              <button class="btn" data-refresh>${icon("refresh", 15)} 刷新课程列表</button>
            </div>`
      }

      <div class="tip-grid">
        <div class="tip-card">
          <span class="tip-index">01</span>
          <h4>抓取需要几十秒</h4>
          <p>课程目录确定后会并发请求每个知识点的卡片、题目和视频详情，进度会实时显示。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">02</span>
          <h4>按需抓取</h4>
          <p>在课程页的“抓取设置”里可以关闭章节测验或视频签名，明显加快速度。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">03</span>
          <h4>结果以服务端为准</h4>
          <p>视频上报成功与否只看接口返回的 <code>isPassed</code>，界面状态不会伪造进度。</p>
        </div>
      </div>
    </section>
  `;

  main.onclick = (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-refresh]")) {
      handlers.onRefreshCourses();
      return;
    }
    if (target.closest("[data-helper]")) {
      handlers.onHelper();
      return;
    }
    const card = target.closest<HTMLElement>("[data-course-id]");
    if (card) handlers.onSelect(card.dataset.courseId ?? "");
  };
}
