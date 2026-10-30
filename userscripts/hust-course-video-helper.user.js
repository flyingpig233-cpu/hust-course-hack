// ==UserScript==
// @name         华科课程平台课程助手
// @namespace    hust-course-hack
// @version      0.3.0
// @description  一键完成视频任务点，并浏览/完成课程内的内联 PDF 文档
// @author       hust-course-hack
// @match        *://smartcourse.hust.edu.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// This is the browser-side implementation of the player path verified against
// the real platform: patch reportProgress, seek to the end, trigger `ended`,
// then call the platform's ed_complete callback. The same injection sequence
// can be reused by a Tauri webview later; the course-wide traversal below is
// what the crawler's chapter ids make possible without hardcoding a course.
// Document task points use the platform's inline PDF viewer instead; see the
// "Document completion" section for its finishJob() path.
(function () {
  'use strict';

  // Only the top window owns the panel; the helper walks child frames itself.
  if (window.top !== window.self) return;

  const PANEL_ID = 'hust-video-helper-panel';
  const STATE_KEY = 'hust-video-helper-course';
  const MAX_LOG_LINES = 200;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let busy = false;
  let stopRequested = false;
  const logLines = [];

  const isStudyPage = () => location.pathname.includes('studentstudy');

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.shift();

    const box = document.querySelector(`#${PANEL_ID} .hvh-log`);
    if (box) {
      box.textContent = logLines.slice(-80).join('\n');
      box.scrollTop = box.scrollHeight;
    }
    console.log('[hust-video-helper]', message);
  }

  function setStatus(text, color = '#e5e7eb') {
    const node = document.querySelector(`#${PANEL_ID} .hvh-status`);
    if (node) {
      node.textContent = text;
      node.style.color = color;
    }
  }

  async function waitFor(fn, timeout = 15000, interval = 300) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeout) {
      try {
        const value = await fn();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    throw lastError || new Error('等待超时');
  }

  // -------------------------------------------------------------------------
  // Frame / player discovery
  // -------------------------------------------------------------------------

  function allWindows() {
    const result = [];
    const queue = [window];
    const seen = new Set();

    while (queue.length) {
      const win = queue.shift();
      if (!win || seen.has(win)) continue;
      seen.add(win);
      result.push(win);

      let doc;
      try {
        doc = win.document;
      } catch {
        continue;
      }
      if (!doc) continue;
      for (const frame of doc.querySelectorAll('iframe')) {
        try {
          if (frame.contentWindow) queue.push(frame.contentWindow);
        } catch {
          // Cross-origin frame; it cannot expose videojs to us.
        }
      }
    }
    return result;
  }

  function playerIsUsable(player) {
    try {
      if (typeof player.isDisposed === 'function' && player.isDisposed()) {
        return false;
      }
      const el = player.el();
      return !!el && (el.offsetWidth > 0 || el.offsetHeight > 0);
    } catch {
      return false;
    }
  }

  function findPlayer() {
    for (const win of allWindows()) {
      let players;
      try {
        players = win.videojs?.getAllPlayers?.() || [];
      } catch {
        continue;
      }
      if (!players.length) continue;
      return {
        win,
        player: players.find(playerIsUsable) || players[0],
      };
    }
    return null;
  }

  function findCardsFrame() {
    for (const win of allWindows()) {
      let doc;
      try {
        doc = win.document;
      } catch {
        continue;
      }
      if (!doc) continue;
      if (doc.querySelector('#prev_tab ul.prev_ul li, ul.prev_ul li')) {
        return { win, doc };
      }
    }
    return null;
  }

  function findCatalog() {
    for (const win of allWindows()) {
      let doc;
      try {
        doc = win.document;
      } catch {
        continue;
      }
      if (!doc) continue;
      const leaves = Array.from(doc.querySelectorAll('div.posCatalog_select[id^="cur"]'));
      if (leaves.length) return { win, doc, leaves };
    }
    return null;
  }

  function getCardTabs(doc) {
    return Array.from(doc.querySelectorAll('#prev_tab ul.prev_ul li, ul.prev_ul li')).map(
      (el, index) => ({
        el,
        title: el.getAttribute('title') || el.textContent.trim() || `card ${index + 1}`,
      }),
    );
  }

  function getLeaves() {
    const catalog = findCatalog();
    if (!catalog) return [];
    return catalog.leaves
      .map((el) => {
        const titleEl = el.querySelector('span.posCatalog_name, span.posCatalog_title');
        return {
          el,
          id: el.id.slice(3),
          title: titleEl?.getAttribute('title') || titleEl?.textContent.trim() || el.id,
          completed: !!el.querySelector('span.icon_Completed'),
        };
      })
      .filter((leaf) => leaf.id);
  }

  function getCourseIdFromUrl() {
    try {
      return new URL(location.href).searchParams.get('courseId');
    } catch {
      return null;
    }
  }

  function callEdComplete() {
    for (const win of allWindows()) {
      try {
        if (typeof win.ed_complete === 'function') {
          win.ed_complete();
          return true;
        }
      } catch {
        // Ignore frames that reject property access.
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Document completion (inline PDF viewer)
  // -------------------------------------------------------------------------

  // Documents are same-origin inline iframes:
  //   <iframe class="insertdoc-online-pdf" data='{"objectid":...}'>
  // Their viewer exposes finishJob() as a plain global. finishJob() sends
  // /mooc-ans/job/document with the page's jtoken and calls ed_complete() only
  // after the server accepts it. This is the platform's own completion path;
  // no token is copied and no synthetic progress is fabricated.
  function allDocFrames() {
    const result = [];
    const seen = new Set();
    for (const win of allWindows()) {
      let doc;
      try {
        doc = win.document;
      } catch {
        continue;
      }
      if (!doc) continue;
      for (const frame of doc.querySelectorAll('iframe.insertdoc-online-pdf')) {
        if (!frame.contentWindow) continue;
        let data = {};
        try {
          data = JSON.parse(frame.getAttribute('data') || '{}');
        } catch {
          // Keep a usable label even if the platform changes the payload.
        }
        const objectid = data.objectid || frame.getAttribute('objectid') || '';
        const jobid = data.jobid || frame.getAttribute('jobid') || '';
        const key = objectid || jobid;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        result.push({
          frame,
          name: data.name || frame.getAttribute('title') || 'PDF 文档',
          objectid,
          jobid,
        });
      }
    }
    return result;
  }

  function docContainer(frame) {
    return frame.closest('.ans-attach-ct') || frame.parentElement;
  }

  function isDocDone(frame) {
    let node = docContainer(frame);
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      if (node.classList && node.classList.contains('ans-job-finished')) return true;
    }
    return false;
  }

  function docIsVisible(frame) {
    try {
      return frame.offsetWidth > 0 && frame.offsetHeight > 0;
    } catch {
      return true;
    }
  }

  async function finishDoc(frame) {
    if (isDocDone(frame)) return { status: 'already' };

    const win = frame.contentWindow;
    try {
      // finishJob needs the course page's AttachmentSetting as well as the
      // viewer's own globals; wait for both before invoking it.
      await waitFor(
        () => typeof win.finishJob === 'function' && win.setting && win.setting.defaults,
        30000,
        300,
      );
    } catch {
      return {
        status: 'unsupported',
        message: '找不到平台 viewer 的 finishJob（可能仍在加载或不是 PDF 路径）',
      };
    }

    if (isDocDone(frame)) return { status: 'already' };

    try {
      win.finishJob();
    } catch (error) {
      return { status: 'error', message: error.message || String(error) };
    }

    const done = await waitFor(() => isDocDone(frame), 12000, 400)
      .then(() => true)
      .catch(() => false);
    return done ? { status: 'done' } : { status: 'timeout' };
  }

  async function completeDocItem(item) {
    if (isDocDone(item.frame)) {
      log(`文档已完成，跳过：${item.name}`);
      return false;
    }

    log(`调用平台完成：${item.name}`);
    const result = await finishDoc(item.frame);
    if (result.status === 'done') {
      log(`文档已完成：${item.name}`);
      return true;
    }
    if (result.status === 'already') {
      log(`文档已经是完成状态：${item.name}`);
      return false;
    }
    if (result.status === 'timeout') {
      log(
        `未确认完成（12s）：${item.name}；检查 Network 中的 /mooc-ans/job/document，或页面是否归档/无 jtoken`,
      );
      return false;
    }
    if (result.status === 'unsupported') {
      log(`无法调用完成：${item.name}（${result.message}）`);
      return false;
    }
    log(`完成失败：${item.name}（${result.message}）`);
    return false;
  }

  async function completeCurrentDocument() {
    const item = allDocFrames().find((doc) => docIsVisible(doc.frame) && !isDocDone(doc.frame));
    if (!item) {
      log('当前页面没有待完成的 PDF 文档');
      return 0;
    }
    return (await completeDocItem(item)) ? 1 : 0;
  }

  async function completeDocumentsOnPage() {
    const cards = await waitFor(findCardsFrame, 15000).catch(() => null);
    const tabCount = cards ? getCardTabs(cards.doc).length : 0;

    if (tabCount === 0) {
      let completed = 0;
      for (const item of allDocFrames().filter((doc) => docIsVisible(doc.frame))) {
        if (stopRequested) break;
        if (await completeDocItem(item)) completed += 1;
      }
      return completed;
    }

    let completed = 0;
    const handled = new Set();
    for (let index = 0; index < tabCount; index += 1) {
      if (stopRequested) break;

      // Switching cards can replace the card iframe; re-query every pass.
      const current = await waitFor(findCardsFrame, 10000).catch(() => null);
      if (!current) continue;
      const tab = getCardTabs(current.doc)[index];
      if (!tab) continue;

      log(`切换卡片 ${index + 1}/${tabCount}: ${tab.title}`);
      tab.el.click();

      // Give the platform time to render this tab's document iframe.
      const docs = await waitFor(() => {
        const list = allDocFrames().filter((doc) => docIsVisible(doc.frame));
        return list.length ? list : null;
      }, 6000).catch(() => []);
      if (!docs.length) {
        log(`卡片 ${index + 1} 没有 PDF 文档，跳过`);
        continue;
      }

      for (const item of docs) {
        if (stopRequested) break;
        const key = item.objectid || item.jobid || item.name;
        if (key && handled.has(key)) continue;
        if (key) handled.add(key);
        if (await completeDocItem(item)) completed += 1;
      }
    }
    return completed;
  }

  function browseCurrentDocument() {
    const item = allDocFrames().find((doc) => docIsVisible(doc.frame));
    if (!item) {
      log('当前页面没有可见的 PDF 文档');
      return;
    }

    try {
      item.frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      item.frame.scrollIntoView();
    }
    const previous = item.frame.style.outline;
    item.frame.style.outline = '3px solid #f59e0b';
    setTimeout(() => {
      item.frame.style.outline = previous;
    }, 2500);
    log(`已定位文档：${item.name}`);
  }

  // -------------------------------------------------------------------------
  // Video completion
  // -------------------------------------------------------------------------

  async function completeCurrentVideo() {
    const found = await waitFor(findPlayer, 20000);
    const { player } = found;

    const duration = await waitFor(() => {
      try {
        const value = player.duration();
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    }, 30000);

    // Patch before seeking: the platform reads this hook when it builds the
    // progress report for the `ended` event. Patching afterwards is too late.
    try {
      player.reportProgress = () => ({
        completed: true,
        duration,
        position: duration,
      });
    } catch {
      // Some players freeze the method; seeding/ending still works.
    }

    try {
      player.muted(true);
    } catch {
      // Muting is best-effort.
    }

    try {
      const playing = player.play();
      if (playing && typeof playing.catch === 'function') {
        await playing.catch(() => {});
      }
    } catch {
      // Autoplay can be refused; the seek below still updates the player.
    }

    try {
      player.currentTime(duration);
    } catch {
      // Ignore; trigger ended regardless.
    }
    try {
      player.trigger('ended');
    } catch {
      // Ignore; ed_complete below is the fallback.
    }

    await sleep(1000);
    const completed = callEdComplete();
    log(completed ? '已触发 ed_complete' : '未找到 ed_complete，依赖播放器上报');
    await sleep(1500);

    return duration;
  }

  async function completeKnowledgePoint() {
    const cards = await waitFor(findCardsFrame, 15000);
    const tabCount = getCardTabs(cards.doc).length;

    // A knowledge point without card tabs still has one content area.
    if (tabCount === 0) {
      await completeCurrentVideo();
      return 1;
    }

    let completed = 0;
    for (let index = 0; index < tabCount; index += 1) {
      if (stopRequested) break;

      // Re-query the frame and tabs on every pass: switching cards can reload
      // the iframe and detach the previous DOM nodes.
      const current = await waitFor(findCardsFrame, 10000);
      const tab = getCardTabs(current.doc)[index];
      if (!tab) continue;

      log(`切换卡片 ${index + 1}/${tabCount}: ${tab.title}`);
      tab.el.click();
      await sleep(1500);

      const player = await waitFor(findPlayer, 6000).catch(() => null);
      if (!player) {
        log(`卡片 ${index + 1} 没有视频，跳过`);
        continue;
      }

      await completeCurrentVideo();
      completed += 1;
    }
    return completed;
  }

  // -------------------------------------------------------------------------
  // Course traversal
  // -------------------------------------------------------------------------

  function loadCourseState() {
    try {
      return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function saveCourseState(state) {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  async function processLeaf(course) {
    await sleep(800);
    const completed = await completeKnowledgePoint();
    course.completedVideos += completed;
    saveCourseState(course);
    return completed;
  }

  async function runCourseLoop() {
    if (busy) return;
    const course = loadCourseState();
    if (!course?.running) return;

    const courseId = getCourseIdFromUrl();
    if (course.courseId && courseId && course.courseId !== courseId) {
      log('当前课程与未完成任务不匹配，停止自动完成');
      course.running = false;
      saveCourseState(course);
      return;
    }

    if (!getLeaves().length) {
      log('未找到章节目录，等待页面加载后再继续');
      setStatus('等待章节目录…', '#fbbf24');
      return;
    }

    busy = true;
    setStatus('自动完成中…', '#fbbf24');
    try {
      while (!stopRequested && course.index < course.ids.length) {
        // A full page reload lands here with phase = navigating: the page is
        // the leaf we just clicked, so process it instead of clicking again.
        if (course.phase === 'navigating') {
          course.phase = 'processing';
          saveCourseState(course);
        }

        if (course.phase === 'idle') {
          const id = course.ids[course.index];
          const leaf = getLeaves().find((item) => item.id === id);
          if (!leaf) {
            log(`找不到知识点 ${id}，跳过`);
            course.index += 1;
            saveCourseState(course);
            continue;
          }

          log(`进入知识点 ${course.index + 1}/${course.ids.length}: ${leaf.title}`);
          course.phase = 'navigating';
          saveCourseState(course);

          const target = leaf.el.querySelector('a') || leaf.el;
          target.click();

          // If the click reloads the page this loop is destroyed and the next
          // page resumes at phase = navigating. If the platform updates the
          // content area in place, fall through after giving it time to load.
          await sleep(1800);
          if (stopRequested) return;
          course.phase = 'processing';
          saveCourseState(course);
        }

        if (course.phase === 'processing') {
          log(`处理知识点 ${course.ids[course.index]}`);
          try {
            const count = await processLeaf(course);
            log(`知识点完成，处理了 ${count} 个视频`);
          } catch (error) {
            log(`知识点处理失败: ${error.message}`);
          }
          course.index += 1;
          course.phase = 'idle';
          saveCourseState(course);
        }
      }

      if (course.index >= course.ids.length) {
        course.running = false;
        saveCourseState(course);
        log(`整门课完成，共完成 ${course.completedVideos} 个视频`);
        setStatus(`完成：${course.completedVideos} 个视频`, '#4ade80');
        sessionStorage.removeItem(STATE_KEY);
      }
    } catch (error) {
      log(`自动完成中断: ${error.message}`);
      setStatus(`已中断: ${error.message}`, '#f87171');
      course.running = false;
      saveCourseState(course);
    } finally {
      busy = false;
    }
  }

  async function startCourse() {
    if (busy) return;
    stopRequested = false;

    const leaves = getLeaves();
    if (!leaves.length) {
      log('未找到章节目录，请确认已经进入课程学习页');
      return;
    }

    const pending = leaves.filter((leaf) => !leaf.completed);
    if (!pending.length) {
      log('章节目录中所有知识点都已完成');
      setStatus('没有待完成的知识点', '#4ade80');
      return;
    }

    const course = {
      running: true,
      courseId: getCourseIdFromUrl(),
      ids: pending.map((leaf) => leaf.id),
      index: 0,
      phase: 'idle',
      completedVideos: 0,
      startedAt: Date.now(),
    };
    saveCourseState(course);
    log(`开始整门课：${course.ids.length} 个未完成知识点`);
    await runCourseLoop();
  }

  function stopAll() {
    stopRequested = true;
    const course = loadCourseState();
    if (course) {
      course.running = false;
      saveCourseState(course);
    }
    setStatus('已停止', '#f87171');
    log('已停止');
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      width: 340px;
      padding: 12px;
      border-radius: 10px;
      background: #111827;
      color: #e5e7eb;
      font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    `;
    panel.innerHTML = `
      <div style="font-size:14px;font-weight:600;margin-bottom:4px;">华科课程助手（视频 / 文档）</div>
      <div class="hvh-status" style="margin-bottom:8px;color:#e5e7eb;">就绪</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        <button data-action="current">完成当前视频</button>
        <button data-action="page">完成本页视频</button>
        <button data-action="course">完成整门课</button>
        <button data-action="doc-browse">浏览当前文档</button>
        <button data-action="doc-current">完成当前文档</button>
        <button data-action="doc-page">完成本页文档</button>
        <button data-action="stop">停止</button>
      </div>
      <pre class="hvh-log" style="
        max-height:180px;overflow:auto;margin:0;padding:8px;
        border-radius:6px;background:#030712;color:#9ca3af;
        font:11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        white-space:pre-wrap;word-break:break-word;
      "></pre>
    `;

    for (const button of panel.querySelectorAll('button')) {
      button.style.cssText = `
        padding:5px 8px;border:0;border-radius:6px;cursor:pointer;
        background:#374151;color:#f9fafb;font-size:12px;
      `;
      button.addEventListener('click', () => runAction(button.dataset.action));
    }
    panel.querySelector('[data-action="stop"]').style.background = '#7f1d1d';

    document.body.appendChild(panel);
  }

  async function runAction(action) {
    if (action === 'stop') {
      stopAll();
      return;
    }

    if (busy) {
      log('当前任务还在运行，请先停止或等待完成');
      return;
    }

    stopRequested = false;
    try {
      if (action === 'current') {
        busy = true;
        setStatus('处理当前视频…', '#fbbf24');
        const duration = await completeCurrentVideo();
        setStatus(`当前视频完成（${Math.round(duration)}s）`, '#4ade80');
      } else if (action === 'page') {
        busy = true;
        setStatus('处理本页视频…', '#fbbf24');
        const count = await completeKnowledgePoint();
        setStatus(`本页完成：${count} 个视频`, '#4ade80');
      } else if (action === 'course') {
        await startCourse();
      } else if (action === 'doc-browse') {
        browseCurrentDocument();
      } else if (action === 'doc-current') {
        busy = true;
        setStatus('处理当前文档…', '#fbbf24');
        const count = await completeCurrentDocument();
        setStatus(count ? '当前文档已完成' : '未确认完成', count ? '#4ade80' : '#f87171');
      } else if (action === 'doc-page') {
        busy = true;
        setStatus('处理本页文档…', '#fbbf24');
        const count = await completeDocumentsOnPage();
        setStatus(`本页完成：${count} 个文档`, count ? '#4ade80' : '#fbbf24');
      }
    } catch (error) {
      log(`失败: ${error.message}`);
      setStatus(`失败: ${error.message}`, '#f87171');
    } finally {
      if (action !== 'course') busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function init() {
    if (!isStudyPage()) return;
    createPanel();

    // Resume a course run interrupted by a full page reload. sessionStorage is
    // per-tab, so this only continues work the user explicitly started here.
    const course = loadCourseState();
    if (course?.running && Array.isArray(course.ids) && course.ids.length > 0) {
      log(`恢复未完成任务：${course.index}/${course.ids.length}`);
      setTimeout(async () => {
        await waitFor(() => getLeaves().length > 0, 15000).catch(() => null);
        runCourseLoop();
      }, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // studentstudy can swap content without a full reload; re-add the panel if
  // the page replaced the body.
  new MutationObserver(() => {
    if (isStudyPage() && !document.getElementById(PANEL_ID) && document.body) {
      createPanel();
    }
  }).observe(document.documentElement, { childList: true });
})();
