import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const banner = `// ==UserScript==
// @name         HUST Course 静态站桥接
// @namespace    hust-course-hack
// @version      1.0.0
// @description  在学校页面使用现有登录态，为你明确连接的课程助手静态站转发请求
// @match        https://smartcourse.hust.edu.cn/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==`;

await build({
  root,
  configFile: false,
  build: {
    emptyOutDir: false,
    outDir: 'dist',
    minify: false,
    lib: { entry: `${root}src/bridge.user.ts`, name: 'HustBridge', formats: ['iife'], fileName: () => 'hust-course-bridge.user.js' },
    rolldownOptions: { output: { banner } },
  },
});
// The dev server serves the exact same compiled bridge as the production site.
await writeFile(`${root}public/hust-course-bridge.user.js`, await readFile(`${root}dist/hust-course-bridge.user.js`));
await writeFile(`${root}dist/.nojekyll`, '');
