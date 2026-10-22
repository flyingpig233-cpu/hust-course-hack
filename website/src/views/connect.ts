import { esc, qs, spinner } from "../dom";
import { isDemo } from "../env";
import { basename } from "../format";
import { icon } from "../icons";
import type { CourseSummary, SessionInfo } from "../types";

export type LoginStatus = "idle" | "opening" | "waiting" | "failed";

export interface ConnectHandlers {
  status: LoginStatus;
  error: string | null;
  onLogin(): void;
}

export function renderConnect(main: HTMLElement, handlers: ConnectHandlers): void {
  main.onclick = null;
  main.onchange = null;
  const busy = handlers.status === "opening" || handlers.status === "waiting";
  const buttonLabel =
    handlers.status === "opening"
      ? "正在打开登录窗口…"
      : handlers.status === "waiting"
        ? "等待登录完成…"
        : handlers.status === "failed"
          ? "重新打开登录窗口"
          : isDemo ? "进入演示模式" : "连接学校课程页面";

  main.innerHTML = `
    <section class="connect-view">
      <div class="connect-hero">
        <div class="eyebrow">HUST · 静态网页版本</div>
        <h1>课程助手<br />在浏览器中运行</h1>
        <p class="connect-lead">
          安装一次桥接脚本，然后连接学校课程页面。在学校窗口登录并允许连接后，
          即可查看课程、视频和练习。使用期间请保持学校窗口打开。
        </p>

        ${
          isDemo
            ? `<div class="demo-notice">${icon("spark", 15)} 演示模式：只使用示例课程，不执行真实任务。<a href="${import.meta.env.BASE_URL}">返回正式版</a></div>`
            : `<div class="bridge-install"><h2>首次使用：安装桥接脚本</h2><p>在浏览器中安装 Tampermonkey，点击下方脚本链接安装。若脚本未运行，请按扩展提示开启用户脚本权限。</p><a class="btn" href="${import.meta.env.BASE_URL}hust-course-bridge.user.js" target="_blank" rel="noopener">安装桥接脚本 .user.js</a><p><a href="?demo=1">先体验演示模式</a> · <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener">获取 Tampermonkey</a></p></div>`
        }

        <div class="connect-card">
          <div class="connect-card-head">
            <span class="connect-step">1</span>
            <div>
              <h2>连接学校页面</h2>
              <p>账号密码只在学校页面输入，Cookie 留在学校域名</p>
            </div>
          </div>
          <button class="btn btn-primary btn-lg" id="login-button" ${busy ? "disabled" : ""}>
            ${busy ? spinner("spinner-sm") : icon("user", 17)}
            <span>${buttonLabel}</span>
          </button>
          ${
            busy
              ? `<div class="login-wait"><span class="pulse-dot"></span> 请在新窗口登录并允许连接。若没有提示，请确认桥接脚本已启用。</div>`
              : ""
          }
          ${
            handlers.error
              ? `<div class="connect-error is-visible">${esc(handlers.error)}</div>`
              : ""
          }
        </div>

        <ol class="connect-steps">
          <li><span>2</span> 在学校窗口完成登录，并允许本站连接</li>
          <li><span>3</span> 返回这里查看课程，保持学校窗口打开</li>
        </ol>
      </div>

      <aside class="connect-aside">
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
        <div class="security-card">
          <div class="security-head">${icon("shield", 16)} 安全说明</div>
          <ul>
            <li>学校窗口使用当前浏览器的登录态，断开连接不会退出学校账号。</li>
            <li>课程数据只保存在内存中，刷新页面后需重新连接。</li>
            <li>Cookie 和账号密码不会传给静态站或 GitHub。</li>
            <li>完成结果以服务端 <code>isPassed</code> 为准。</li>
          </ul>
        </div>
      </aside>
    </section>
  `;

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
            ${esc(basename(session.cookieSource))}
          </p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-helper>${icon("copy", 15)} 助手脚本</button>
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
                  <button class="course-card" data-course-id="${esc(course.course_id)}" style="--delay:${index * 30}ms">
                    <div class="course-card-top">
                      <span class="course-avatar course-avatar-lg tone-${sum % 5}">${esc(initial)}</span>
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
