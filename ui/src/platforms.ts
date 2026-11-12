import type { Platform } from "./types";

export interface PlatformMeta {
  id: Platform;
  label: string;
  mark: string;
  sessionTitle: string;
  loginButton: string;
  retryButton: string;
  openingLabel: string;
  closedError: string;
  courseListLabel: string;
  connectedToast: string;
}

const PLATFORM_META: Record<Platform, PlatformMeta> = {
  hust: {
    id: "hust",
    label: "学在华科大",
    mark: "H",
    sessionTitle: "学在华科大",
    loginButton: "登录",
    retryButton: "重新登录",
    openingLabel: "打开中…",
    closedError: "未完成登录",
    courseListLabel: "课程",
    connectedToast: "已登录",
  },
  zhihuishu: {
    id: "zhihuishu",
    label: "知到",
    mark: "知",
    sessionTitle: "知到",
    loginButton: "登录",
    retryButton: "重新登录",
    openingLabel: "打开中…",
    closedError: "未完成登录",
    courseListLabel: "课程",
    connectedToast: "已登录",
  },
  ulearning: {
    id: "ulearning",
    label: "优学院",
    mark: "优",
    sessionTitle: "优学院",
    loginButton: "登录",
    retryButton: "重新登录",
    openingLabel: "打开中…",
    closedError: "未完成登录",
    courseListLabel: "课程",
    connectedToast: "已登录",
  },
};

export const PLATFORM_ORDER: Platform[] = ["hust", "zhihuishu", "ulearning"];

export function platformMeta(platform: Platform): PlatformMeta {
  return PLATFORM_META[platform];
}

export function platformLabel(platform: Platform): string {
  return PLATFORM_META[platform].label;
}
