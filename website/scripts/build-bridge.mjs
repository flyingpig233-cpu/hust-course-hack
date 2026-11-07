import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

const bridges = [
  {
    entry: 'src/bridge.user.ts',
    name: 'HustBridge',
    fileName: 'hust-course-bridge.user.js',
    banner: `// ==UserScript==
// @name         HUST Course 静态站桥接
// @namespace    hust-course-hack
// @version      1.1.0
// @description  在学校页面使用现有登录态，为你明确连接的课程助手静态站转发请求
// @match        https://smartcourse.hust.edu.cn/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==`,
  },
  {
    entry: 'src/zhs-bridge.user.ts',
    name: 'ZhsBridge',
    fileName: 'zhihuishu-bridge.user.js',
    banner: `// ==UserScript==
// @name         知到（智慧树）静态站桥接
// @namespace    hust-course-hack
// @version      1.0.0
// @description  在知到页面使用现有登录态，为你明确连接的课程助手静态站转发知到接口请求
// @match        https://onlineweb.zhihuishu.com/onlinestuh5*
// @match        https://online.zhihuishu.com/*
// @match        https://studyvideoh5.zhihuishu.com/*
// @match        https://stuonline.zhihuishu.com/*
// @match        https://lc.zhihuishu.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==`,
  },
  {
    entry: 'src/ul-bridge.user.ts',
    name: 'UlBridge',
    fileName: 'ulearning-bridge.user.js',
    banner: `// ==UserScript==
// @name         优学院静态站桥接
// @namespace    hust-course-hack
// @version      1.0.0
// @description  在优学院页面使用现有登录态，为你明确连接的课程助手静态站转发优学院接口请求
// @match        https://courseweb.ulearning.cn/*
// @match        https://ua.ulearning.cn/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==`,
  },
];

for (const bridge of bridges) {
  await build({
    root,
    configFile: false,
    build: {
      emptyOutDir: false,
      outDir: 'dist',
      minify: false,
      lib: { entry: `${root}${bridge.entry}`, name: bridge.name, formats: ['iife'], fileName: () => bridge.fileName },
      rolldownOptions: { output: { banner: bridge.banner } },
    },
  });
  // The dev server serves the exact same compiled bridges as the production site.
  await writeFile(`${root}public/${bridge.fileName}`, await readFile(`${root}dist/${bridge.fileName}`));
}
await writeFile(`${root}dist/.nojekyll`, '');
