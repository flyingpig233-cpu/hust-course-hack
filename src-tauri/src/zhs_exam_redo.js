// Injected into the isolated exam webview for the webview-driven redo flow.
//
// The platform's `student/applyRedo` API is a dead end, so the working path is
// the exam-list UI: switch to 已提交, find the target card, click 申请重做,
// confirm the dialog and wait for the card to leave the submitted list. This
// script performs exactly that sequence, reports back through
// `zhs_exam_redo_result` and renders a diagnostic panel (never a random click)
// when a selector step fails.

(function () {
  'use strict';

  var CTX = window.__ZHS_EXAM_CTX__ || {};
  if (window.__ZHS_REDO__) {
    return;
  }
  var R = { running: false, done: false, logLines: [] };
  window.__ZHS_REDO__ = R;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function rand(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function clean(text) {
    return String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function norm(text) {
    return clean(text)
      .replace(/[\s，。；：、（）()"'“”‘’？！?!,.;:\/\\]/g, '')
      .toLowerCase();
  }

  function invoke(cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject(new Error('Tauri IPC 不可用'));
    }
    return internals.invoke(cmd, args);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  // ---- overlay -----------------------------------------------------------

  var overlay = null;
  var statusNode = null;
  var logNode = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.id = '__zhs_redo_overlay';
    overlay.setAttribute(
      'style',
      [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'z-index:2147483647',
        'width:360px',
        'max-height:64vh',
        'overflow:auto',
        'padding:12px 14px',
        'border-radius:12px',
        'background:#111827',
        'color:#f9fafb',
        'font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif',
        'box-shadow:0 12px 32px rgba(0,0,0,.45)',
      ].join(';'),
    );
    overlay.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">知到 · 申请重做</div>' +
      '<div id="__zhs_redo_status" style="opacity:.9;min-height:34px;white-space:pre-wrap">等待考试列表加载…</div>' +
      '<div style="display:flex;gap:8px;margin:10px 0">' +
      '<button id="__zhs_redo_stop" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:#374151;color:#fff">停止</button>' +
      '</div>' +
      '<div id="__zhs_redo_log" style="opacity:.75;font-size:12px;max-height:170px;overflow:auto"></div>' +
      '<div style="opacity:.6;margin-top:8px">只会点击「已提交 → 申请重做 → 确定」，失败时显示诊断面板。</div>';
    document.documentElement.appendChild(overlay);
    statusNode = overlay.querySelector('#__zhs_redo_status');
    logNode = overlay.querySelector('#__zhs_redo_log');
    overlay.querySelector('#__zhs_redo_stop').addEventListener('click', function () {
      R.stopped = true;
      setStatus('已请求停止…');
    });
  }

  function setStatus(text) {
    if (statusNode) statusNode.textContent = text;
  }

  function log(text) {
    var line = String(text);
    R.logLines.push(line);
    while (R.logLines.length > 40) R.logLines.shift();
    try {
      if (window.__ZHS_PUSH_LOG__) window.__ZHS_PUSH_LOG__(line);
    } catch (e) {
      /* ignore */
    }
    if (!logNode) return;
    var node = document.createElement('div');
    node.textContent = line;
    logNode.appendChild(node);
    while (logNode.childElementCount > 120) logNode.firstElementChild.remove();
    logNode.scrollTop = logNode.scrollHeight;
  }

  function hideLoadingPanel() {
    try {
      if (window.__ZHS_HIDE_LOADING__) window.__ZHS_HIDE_LOADING__();
    } catch (e) {
      /* ignore */
    }
  }

  function injectedCookieCount() {
    var count = Number(window.__ZHS_INJECTED_COUNT__ || 0);
    return Number.isFinite(count) ? count : 0;
  }

  function lastLogLines(count) {
    return R.logLines.slice(-count).join('\n');
  }

  function fail(reason, extra) {
    R.running = false;
    R.done = true;
    setStatus('申请重做失败：' + reason);
    log('失败：' + reason);
    var detail =
      reason +
      '\n\n目标：' +
      String(CTX.targetName || CTX.examId || '') +
      '\n地址：' +
      String(location.href) +
      '\n已注入 Cookie ' +
      injectedCookieCount() +
      ' 条' +
      (extra ? '\n' + extra : '') +
      '\n\n最近日志：\n' +
      lastLogLines(10);
    try {
      if (window.__ZHS_SHOW_ERROR__) window.__ZHS_SHOW_ERROR__('申请重做失败', detail);
    } catch (e) {
      /* ignore */
    }
    void invoke('zhs_exam_redo_result', {
      examId: CTX.examId || '',
      ok: false,
      reason: reason + (extra ? ' | ' + extra : ''),
    }).catch(function () {
      /* ignore */
    });
  }

  function succeed() {
    R.running = false;
    R.done = true;
    setStatus('申请重做成功，正在关闭窗口并打开作答窗口…');
    log('申请重做成功');
    void invoke('zhs_exam_redo_result', {
      examId: CTX.examId || '',
      ok: true,
      reason: '申请重做成功',
    }).catch(function (error) {
      log('上报成功结果失败：' + (error && error.message ? error.message : String(error)));
    });
  }

  // ---- DOM helpers -------------------------------------------------------

  function clickNode(node) {
    try {
      node.scrollIntoView({ block: 'center' });
      node.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  function captchaVisible() {
    if (document.querySelector('.yidun_bg-img, .yidun_popup, [class*="yidun" i]')) {
      return true;
    }
    var text = clean(document.body ? document.body.innerText : '');
    return /请完成安全验证|请点击.*验证|安全验证/.test(text);
  }

  function visibleLeafByText(regexp, maxLength) {
    var nodes = Array.from(document.querySelectorAll('button,a,span,div,li,label,p'));
    var out = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!isVisible(node)) continue;
      var text = clean(node.innerText || node.textContent);
      if (!text || text.length > (maxLength || 24)) continue;
      if (!regexp.test(text)) continue;
      var childSame = Array.from(node.children).some(function (child) {
        return clean(child.innerText || child.textContent) === text;
      });
      if (childSame) continue;
      out.push({ node: node, text: text });
    }
    return out;
  }

  function findSubmittedTab() {
    var direct = document.querySelector('#examStateTabYsj');
    if (direct && isVisible(direct)) return direct;
    var candidates = visibleLeafByText(/^已提交(试卷)?$/, 8);
    for (var i = 0; i < candidates.length; i += 1) {
      var node = candidates[i].node;
      if (node.closest('[class*="tab" i],[role="tab"],[class*="examState" i]')) return node;
    }
    return null;
  }

  function findRedoButtons() {
    return visibleLeafByText(/^(申请重做|申请重做作业|重做)$/, 24);
  }

  function cardAncestorOf(node, target) {
    var el = node;
    for (var depth = 0; depth < 10 && el; depth += 1, el = el.parentElement) {
      if (!isVisible(el)) continue;
      var text = clean(el.innerText || el.textContent);
      if (text.length > 2000) break;
      var normalized = norm(text);
      if (normalized.indexOf(norm(target)) >= 0) return el;
    }
    return null;
  }

  function findTargetRedo(target) {
    var buttons = findRedoButtons();
    for (var i = 0; i < buttons.length; i += 1) {
      var card = cardAncestorOf(buttons[i].node, target);
      if (card) return { button: buttons[i].node, card: card };
    }
    return null;
  }

  function dialogContainer() {
    var selectors = [
      '[class*="dialog" i]',
      '[class*="modal" i]',
      '[class*="confirm" i]',
      '[role="dialog"]',
      '[class*="popup" i]',
    ];
    for (var i = 0; i < selectors.length; i += 1) {
      var nodes = Array.from(document.querySelectorAll(selectors[i])).filter(isVisible);
      if (nodes.length > 0) return nodes[nodes.length - 1];
    }
    return null;
  }

  function dialogText() {
    var dialog = dialogContainer();
    return dialog ? clean(dialog.innerText || dialog.textContent).slice(0, 500) : '';
  }

  function findConfirmButton() {
    var dialog = dialogContainer();
    if (!dialog) return null;
    var candidates = Array.from(dialog.querySelectorAll('button,a,span,div')).filter(isVisible);
    for (var i = 0; i < candidates.length; i += 1) {
      var text = clean(candidates[i].innerText || candidates[i].textContent);
      if (/^(确定|确认|确认重做|继续|好的)$/.test(text)) {
        var childSame = Array.from(candidates[i].children).some(function (child) {
          return clean(child.innerText || child.textContent) === text;
        });
        if (!childSame) return candidates[i];
      }
    }
    return null;
  }

  function successToastVisible() {
    var text = clean(document.body ? document.body.innerText : '');
    return /申请成功|重做成功|已申请|操作成功/.test(text);
  }

  function targetCardGone(target) {
    return findTargetRedo(target) === null;
  }

  async function waitFor(predicate, timeoutMs, intervalMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (R.stopped) return false;
      try {
        if (predicate()) return true;
      } catch (e) {
        /* ignore */
      }
      await sleep(intervalMs || 400);
    }
    return false;
  }

  // ---- redo flow ---------------------------------------------------------

  async function run() {
    if (R.running) return;
    R.running = true;
    R.stopped = false;
    ensureOverlay();
    hideLoadingPanel();
    setStatus('已注入 Cookie ' + injectedCookieCount() + ' 条，等待考试列表加载…');
    log('已注入 Cookie ' + injectedCookieCount() + ' 条');
    var target = String(CTX.targetName || CTX.examId || '').trim();
    if (!target) {
      fail('缺少目标作业名称（targetName 为空）');
      return;
    }
    log('目标作业：' + target);

    // 1. Wait for the SPA list; a captcha can appear before it renders.
    var listReady = await waitFor(function () {
      if (captchaVisible()) {
        setStatus('检测到安全验证，请在窗口内手动完成；通过后自动继续…');
        return false;
      }
      return findSubmittedTab() !== null || findRedoButtons().length > 0;
    }, 120000, 600);
    if (!listReady) {
      fail('等待考试列表超时（未找到「已提交」标签）');
      return;
    }

    // 2. Switch to 已提交 and verify the tab actually rendered cards.
    var tab = findSubmittedTab();
    if (!tab) {
      fail('未找到「已提交」标签（#examStateTabYsj）');
      return;
    }
    setStatus('切换到「已提交」…');
    log('点击已提交标签');
    clickNode(tab);
    await sleep(rand(700, 1400));
    var cardsReady = await waitFor(function () {
      return findRedoButtons().length > 0;
    }, 20000, 500);
    if (!cardsReady) {
      fail('切换到「已提交」后没有找到任何「申请重做」按钮');
      return;
    }

    // 3. Find the target card and click its 申请重做.
    setStatus('查找目标作业：' + target);
    var found = null;
    var foundReady = await waitFor(function () {
      found = findTargetRedo(target);
      return found !== null;
    }, 20000, 500);
    if (!foundReady || !found) {
      var bodyText = clean(document.body ? document.body.innerText : '').slice(0, 600);
      fail('已提交列表中没有找到包含「' + target + '」的卡片', '页面文本片段：' + bodyText);
      return;
    }
    log('找到目标卡片，点击「申请重做」');
    setStatus('点击「申请重做」…');
    found.button.scrollIntoView({ block: 'center' });
    await sleep(400);
    clickNode(found.button);

    // 4. Confirm the dialog. Only buttons inside a dialog/modal are clicked.
    await sleep(1200);
    var confirm = findConfirmButton();
    if (!confirm) {
      log('未检测到确认对话框，继续等待列表变化');
    } else {
      log('确认对话框：' + dialogText());
      setStatus('点击「确定」确认申请重做…');
      clickNode(confirm);
    }

    // 5. Wait until the card leaves 已提交 or a success toast appears.
    setStatus('等待申请重做结果…');
    var ok = await waitFor(function () {
      return successToastVisible() || targetCardGone(target);
    }, 10000, 500);
    if (ok) {
      succeed();
      return;
    }
    var dialog = dialogText();
    var cardHtml = found.card && found.card.outerHTML ? found.card.outerHTML.slice(0, 600) : '';
    fail(
      '点击后 10 秒内列表没有变化（申请重做可能未生效）',
      (dialog ? '对话框文本：' + dialog + '\n' : '') +
        (cardHtml ? '卡片片段：' + cardHtml : ''),
    );
  }

  // ---- boot --------------------------------------------------------------

  function boot() {
    if (!/webExamList/i.test(String(location.hash || ''))) {
      setTimeout(boot, 2500);
      return;
    }
    if (R.running || R.done) return;
    ensureOverlay();
    setTimeout(function () {
      void run();
    }, 3000);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', function () {
      setTimeout(boot, 1500);
    });
  } else {
    setTimeout(boot, 1500);
  }
})();
