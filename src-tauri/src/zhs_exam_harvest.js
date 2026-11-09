// Injected into the isolated Zhihuishu exam webview.
//
// The harvested webview loads the platform's own "check submitted homework" page,
// where each question has an 「AI解析」 button. This script clicks those buttons
// one at a time (paced 1-3 s), reads the analysis panel text, and finally sends
// `{questionId?, index, text}` entries back to the Tauri backend through
// `zhs_exam_record_ai`. It NEVER clicks submit, answer options, next-page or any
// other control; only the AI-analysis toggles and its own overlay.
//
// The DOM is not officially documented, so every selector below is tolerant and
// falls back to text heuristics. If the platform changes the page, the UI's
// 「手动导入」 fallback still works.

(function () {
  'use strict';

  var CTX = window.__ZHS_EXAM_CTX__ || {};
  if (window.__ZHS_EXAM_HARVEST__) {
    return;
  }
  var H = {
    running: false,
    stopped: false,
    done: false,
    entries: [],
    total: 0,
  };
  window.__ZHS_EXAM_HARVEST__ = H;

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
  var progressNode = null;
  var stopButton = null;
  var startButton = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.id = '__zhs_exam_harvest_overlay';
    overlay.setAttribute(
      'style',
      [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'z-index:2147483647',
        'width:320px',
        'padding:12px 14px',
        'border-radius:12px',
        'background:#111827',
        'color:#f9fafb',
        'font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif',
        'box-shadow:0 12px 32px rgba(0,0,0,.45)',
      ].join(';'),
    );
    overlay.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">知到 AI解析采集</div>' +
      '<div id="__zhs_status" style="opacity:.86;min-height:32px;white-space:pre-wrap">等待进入已提交试卷页…</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button id="__zhs_start" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:#2563eb;color:#fff">开始采集</button>' +
      '<button id="__zhs_stop" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:#374151;color:#fff">停止</button>' +
      '</div>' +
      '<div style="opacity:.6;margin-top:8px">只点击「AI解析」，不会提交试卷。</div>';
    document.documentElement.appendChild(overlay);
    statusNode = overlay.querySelector('#__zhs_status');
    startButton = overlay.querySelector('#__zhs_start');
    stopButton = overlay.querySelector('#__zhs_stop');
    startButton.addEventListener('click', function () {
      if (!H.running) void run();
    });
    stopButton.addEventListener('click', function () {
      H.stopped = true;
      setStatus('已请求停止…');
    });
  }

  function setStatus(text) {
    if (statusNode) statusNode.textContent = text;
  }

  function updateProgress(done, total) {
    if (!statusNode) return;
    var text = done + ' / ' + total;
    if (progressNode && progressNode.isConnected) {
      progressNode.textContent = text;
    }
  }

  // ---- DOM discovery -----------------------------------------------------

  var AI_TEXT = /^AI\s*解析/;
  var QUESTION_CLASS = /question|subject|exam-item|que-item|paper-question|topic/i;
  var QID_ATTRS = [
    'data-question-id',
    'data-questionid',
    'data-question',
    'data-qid',
    'data-id',
    'questionid',
    'qid',
  ];

  /** Every visible element whose whole text is exactly the AI-analysis label. */
  function aiButtons() {
    var nodes = Array.from(document.querySelectorAll('button,a,span,div,i,em'));
    var buttons = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var text = clean(el.textContent);
      if (!text || text.length > 12 || !AI_TEXT.test(text)) continue;
      // Leaf only: a container whose child repeats the same label would
      // double-count (and clicking the container does nothing).
      var childSame = Array.from(el.children).some(function (child) {
        return clean(child.textContent) === text;
      });
      if (childSame) continue;
      if (!isVisible(el)) continue;
      buttons.push(el);
    }
    return buttons;
  }

  function cardOf(button) {
    var el = button;
    for (var depth = 0; depth < 8 && el; depth += 1, el = el.parentElement) {
      var marker = String(el.className || '') + ' ' + String(el.id || '');
      if (QUESTION_CLASS.test(marker)) return el;
    }
    var parent = button.parentElement;
    for (var i = 0; i < 6 && parent; i += 1, parent = parent.parentElement) {
      if (
        parent.querySelector(
          'input[type=radio],input[type=checkbox],[class*="option"],[class*="Option"]',
        )
      ) {
        return parent;
      }
    }
    return button.parentElement || document.body;
  }

  function questionIdOf(card) {
    var el = card;
    for (var depth = 0; depth < 6 && el; depth += 1, el = el.parentElement) {
      for (var i = 0; i < QID_ATTRS.length; i += 1) {
        var value = el.getAttribute && el.getAttribute(QID_ATTRS[i]);
        if (value && /^[A-Za-z0-9_-]{4,}$/.test(value)) return value;
      }
    }
    var html = card.outerHTML || '';
    var match = html.match(/(?:questionId|questionid|qid)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{4,})/);
    return match ? match[1] : null;
  }

  var PANEL_SELECTORS = [
    '[class*="analysis" i]',
    '[class*="analy" i]',
    '[class*="explain" i]',
    '[class*="jiexi" i]',
    '[id*="analysis" i]',
  ];

  function panelTextNear(card) {
    for (var i = 0; i < PANEL_SELECTORS.length; i += 1) {
      var nodes = Array.from(card.querySelectorAll(PANEL_SELECTORS[i]));
      for (var j = 0; j < nodes.length; j += 1) {
        if (!isVisible(nodes[j])) continue;
        var text = clean(nodes[j].innerText || nodes[j].textContent);
        if (text.length >= 15 && !AI_TEXT.test(text)) return text;
      }
    }
    for (var k = 0; k < PANEL_SELECTORS.length; k += 1) {
      var panels = Array.from(document.querySelectorAll(PANEL_SELECTORS[k])).filter(isVisible);
      for (var m = 0; m < panels.length; m += 1) {
        var full = clean(panels[m].innerText || panels[m].textContent);
        if (full.length >= 30 && /解析|答案|正确|选项|故选|答案为/.test(full)) return full;
      }
    }
    return null;
  }

  /** Fallback: return the text appended to the card after clicking. */
  function appendedText(card, before) {
    var after = clean(card.innerText || card.textContent);
    if (!after || after === before) return null;
    if (after.length <= before.length + 8) return null;
    var i = 0;
    while (i < before.length && before[i] === after[i]) i += 1;
    var tail = after.slice(i).trim();
    if (tail.length >= 10 && /解析|答案|正确|选项|故选|答案为/.test(tail)) return tail;
    if (tail.length >= 30) return tail;
    return null;
  }

  async function collectOne(button, index, total) {
    var card = cardOf(button);
    var questionId = questionIdOf(card);
    var before = clean(card.innerText || card.textContent);
    setStatus('AI解析 ' + (index + 1) + ' / ' + total + '：点击并等待解析面板…');

    try {
      button.click();
    } catch (e) {
      return { questionId: questionId, index: index, text: '' };
    }

    var text = null;
    var deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(300);
      if (H.stopped) break;
      text = panelTextNear(card) || appendedText(card, before);
      if (text) break;
    }

    // Best effort: toggle the panel closed again before the next question.
    try {
      button.click();
    } catch (e) {
      /* ignore */
    }
    await sleep(250);

    // Timeouts are reported as an empty text so the backend can list the
    // skipped question ids instead of silently dropping them.
    return { questionId: questionId, index: index, text: text || '' };
  }

  // ---- run loop ----------------------------------------------------------

  async function run() {
    if (H.running) return;
    H.running = true;
    H.stopped = false;
    H.done = false;
    H.entries = [];
    ensureOverlay();

    setStatus('正在查找「AI解析」按钮…');
    var buttons = aiButtons();
    if (buttons.length === 0) {
      setStatus('未找到 AI解析 按钮。请确认已进入「查看已提交试卷」（checkHomework）页；也可关闭窗口后用「手动导入」。');
      H.running = false;
      return;
    }
    H.total = buttons.length;
    setStatus('共找到 ' + buttons.length + ' 个 AI解析 按钮，开始采集…');

    var collected = 0;
    for (var i = 0; i < buttons.length; i += 1) {
      if (H.stopped) break;
      var entry = null;
      try {
        entry = await collectOne(buttons[i], i, buttons.length);
      } catch (e) {
        entry = null;
      }
      if (entry) {
        H.entries.push(entry);
        if (entry.text) collected += 1;
      }
      setStatus(
        '已采集 ' +
          collected +
          ' / ' +
          buttons.length +
          (entry && entry.text ? '：收录本题' : '：本题未识别到解析（记为跳过）'),
      );
      if (i < buttons.length - 1 && !H.stopped) {
        await sleep(rand(1000, 3000));
      }
    }

    H.running = false;
    H.done = true;

    if (H.entries.length === 0) {
      setStatus('未采集到解析文本。请检查页面是否加载完成，或使用「手动导入」。');
      return;
    }

    setStatus('采集完成 ' + H.entries.length + ' 题，正在写入答案库…');
    try {
      var result = await invoke('zhs_exam_record_ai', {
        recruitId: CTX.recruitId,
        courseId: CTX.courseId,
        examId: CTX.examId,
        entries: H.entries,
      });
      setStatus(
        '写入完成：记录 ' +
          result.recorded +
          ' 题，跳过 ' +
          result.skipped +
          ' 题，答案库共 ' +
          result.bankTotal +
          ' 条。可以关闭本窗口。',
      );
    } catch (err) {
      setStatus(
        '写入答案库失败：' +
          (err && err.message ? err.message : String(err)) +
          '。可在主窗口使用「手动导入」。',
      );
    }
  }

  // ---- boot --------------------------------------------------------------

  function boot() {
    if (!/checkHomework/i.test(String(location.hash || ''))) {
      ensureOverlay();
      setStatus('等待加载「查看已提交试卷」页…');
      setTimeout(boot, 2500);
      return;
    }
    ensureOverlay();
    setStatus('页面已就绪，4 秒后自动开始采集（也可手动点击“开始采集”）。');
    setTimeout(function () {
      if (!H.running && !H.done) void run();
    }, 4000);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', function () {
      setTimeout(boot, 1500);
    });
  } else {
    setTimeout(boot, 1500);
  }
})();
