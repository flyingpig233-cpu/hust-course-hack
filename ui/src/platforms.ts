// Platform metadata shared by the connect screen, the sidebar and the routers.
// Keeping the copy here means adding a platform does not clone a third view.
import type { IconName } from "./icons";
import type { Platform } from "./types";

export interface PlatformFeature {
  icon: IconName;
  tone: string;
  title: string;
  body: string;
}

export interface PlatformMeta {
  id: Platform;
  /** Full label used in the platform switch and messages. */
  label: string;
  /** One-character mark shown inside the switch. */
  mark: string;
  /** Sidebar brand subtitle. */
  brandSub: string;
  /** Sidebar session card title (`已连接 ${sessionTitle}`). */
  sessionTitle: string;
  eyebrow: string;
  title: string;
  lead: string;
  loginTitle: string;
  loginHint: string;
  loginButton: string;
  retryButton: string;
  openingLabel: string;
  closedError: string;
  demoLogin: string;
  step3: string;
  features: PlatformFeature[];
  securityTitle: string;
  securityItems: string[];
  /** Sidebar course list label. */
  courseListLabel: string;
  idleHint: string;
  /** Toast shown after the login window verified the session. */
  connectedToast: string;
}

const HUST: PlatformMeta = {
  id: "hust",
  label: "学在华科大",
  mark: "H",
  brandSub: "SmartCourse 桌面助手",
  sessionTitle: "SmartCourse",
  eyebrow: "HUST · 统一身份认证",
  title: "用学校账号<br />登录课程助手",
  lead: "点击登录后会打开学校统一身份认证窗口。登录成功后，应用自动读取本次会话并关闭窗口，不需要再导出 cookies.txt。",
  loginTitle: "统一身份认证",
  loginHint: "账号密码只在学校页面输入，本应用不会读取",
  loginButton: "打开 HUST 登录窗口",
  retryButton: "重新打开登录窗口",
  openingLabel: "正在打开登录窗口…",
  closedError:
    "登录窗口已关闭，未获取到学校会话。请重新打开登录窗口完成统一身份认证。",
  demoLogin: "统一身份认证",
  step3: "自动读取会话并加载课程列表",
  features: [
    {
      icon: "folder",
      tone: "tone-blue",
      title: "课程结构一目了然",
      body: "章 / 节 / 知识点三级树，视频、文档、测验任务点与完成状态集中在同一页。",
    },
    {
      icon: "work",
      tone: "tone-violet",
      title: "测验答案与得分",
      body: "已批改作业展示正确答案、我的答案与得分；未批改作业只显示题目。",
    },
    {
      icon: "video",
      tone: "tone-green",
      title: "视频进度上报",
      body: "复现播放器心跳，支持整门课或单个视频；每次运行重新获取签名，不保存 dtoken。",
    },
  ],
  securityTitle: "安全说明",
  securityItems: [
    "登录窗口使用独立的临时浏览器配置，会话读取后立即清理。",
    "会话只保存在内存中，用于请求课程接口。",
    "不保存 cookies.txt，也不接触账号密码。",
    "完成结果以服务端 <code>isPassed</code> 为准。",
  ],
  courseListLabel: "我的课程",
  idleHint: "登录学校账号开始",
  connectedToast: "已通过学校统一身份认证登录",
};

const ZHIHUISHU: PlatformMeta = {
  id: "zhihuishu",
  label: "知到（智慧树）",
  mark: "知",
  brandSub: "知到（智慧树）桌面助手",
  sessionTitle: "知到",
  eyebrow: "知到 · 智慧树共享课",
  title: "登录知到<br />秒刷共享课与见面课",
  lead: "点击登录后会打开知到登录窗口。登录成功后，应用自动读取本次会话（含 HttpOnly Cookie）并用 getLoginUserInfo 校验，不需要再导出 cookies.txt。",
  loginTitle: "知到网页登录",
  loginHint: "账号密码只在知到页面输入，Cookie 不跨 IPC 传给界面",
  loginButton: "打开知到登录窗口",
  retryButton: "重新连接知到",
  openingLabel: "正在打开知到窗口…",
  closedError:
    "登录窗口已关闭，未获取到知到会话。请重新打开知到登录窗口并完成登录。",
  demoLogin: "知到",
  step3: "自动读取会话并加载知到共享课列表",
  features: [
    {
      icon: "video",
      tone: "tone-blue",
      title: "共享课视频秒刷",
      body: "章 / 节 / 小节三级视频树，标明完成状态；默认试运行，确认风险后才会真正上报。",
    },
    {
      icon: "live",
      tone: "tone-violet",
      title: "见面课回放考勤",
      body: "列出有回放的场次与已看 / 总分钟，按随机 90–100% 覆盖率逐分钟上报，带限速与风控熔断。",
    },
    {
      icon: "shield",
      tone: "tone-green",
      title: "Cookie 不跨 IPC",
      body: "登录窗口使用独立临时浏览器配置，Cookie 只在 Rust 侧构建请求会话，前端只看到会话元信息。",
    },
  ],
  securityTitle: "风险提示",
  securityItems: [
    "秒刷属于最高风险形态，可能导致账号被风控或成绩判定异常。",
    "视频课与见面课默认试运行，真实执行需勾选风险确认。",
    "日志与界面不展示 Cookie、签名或 secretStr。",
    "完成结果以服务端 <code>watchState</code> / 观看历史为准。",
  ],
  courseListLabel: "共享课",
  idleHint: "登录知到账号开始",
  connectedToast: "已连接知到账号",
};

const ULEARNING: PlatformMeta = {
  id: "ulearning",
  label: "优学院（U学）",
  mark: "优",
  brandSub: "优学院（U学）桌面助手",
  sessionTitle: "优学院",
  eyebrow: "优学院 · U学学生端",
  title: "登录优学院<br />秒刷课程课件",
  lead: "点击登录后会打开优学院登录窗口。登录成功后，应用自动读取会话里的 AUTHORIZATION Cookie，并用 /user 接口校验后建立会话，不需要再导出 cookies.txt。",
  loginTitle: "优学院网页登录",
  loginHint: "账号密码只在优学院页面输入，Cookie 不跨 IPC 传给界面",
  loginButton: "打开优学院登录窗口",
  retryButton: "重新连接优学院",
  openingLabel: "正在打开优学院窗口…",
  closedError:
    "登录窗口已关闭，未获取到优学院会话。请重新打开优学院登录窗口并完成登录。",
  demoLogin: "优学院",
  step3: "自动读取会话并加载优学院课程",
  features: [
    {
      icon: "video",
      tone: "tone-blue",
      title: "课件视频与练习秒刷",
      body: "按章 / 节 / 页提交课件完成记录，视频节与含答案的练习节都能处理；默认试运行。",
    },
    {
      icon: "folder",
      tone: "tone-violet",
      title: "章 · 节 · 页树",
      body: "视频 / 练习 / 图文页类型一目了然，可先检查每节 completion_status 再决定是否执行。",
    },
    {
      icon: "shield",
      tone: "tone-green",
      title: "限速与熔断",
      body: "真实执行默认 3–5 秒间隔；服务端返回 2（判定刷分）立即中止整批，不重试。",
    },
  ],
  securityTitle: "风险提示",
  securityItems: [
    "秒刷课件属于高风险操作，可能导致账号被风控或课程进度异常。",
    "默认试运行，真实执行需勾选风险确认。",
    "界面与日志不展示 AUTHORIZATION token、DES 请求体或练习答案。",
    "完成结果以服务端 <code>completion_status=1</code> 为准。",
  ],
  courseListLabel: "课程",
  idleHint: "登录优学院账号开始",
  connectedToast: "已连接优学院账号",
};

const PLATFORM_META: Record<Platform, PlatformMeta> = {
  hust: HUST,
  zhihuishu: ZHIHUISHU,
  ulearning: ULEARNING,
};

export const PLATFORM_ORDER: Platform[] = ["hust", "zhihuishu", "ulearning"];

export function platformMeta(platform: Platform): PlatformMeta {
  return PLATFORM_META[platform];
}

export function platformLabel(platform: Platform): string {
  return PLATFORM_META[platform].label;
}
