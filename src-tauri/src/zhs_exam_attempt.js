// Injected into the isolated Zhihuishu exam webview for a webview-driven
// attempt (`#/webExamList/dohomework/...`).
//
// Why this exists: the platform blocks direct API attempts with a slider
// captcha (`student/doHomework` -> code -12). This script therefore lets the
// user complete the captcha manually in the window, then:
//   1. reads the paper questions from the DOM,
//   2. asks the Rust backend for the answer bank plan
//      (`zhs_exam_webview_plan`, answers keyed by question id),
//   3. after an explicit 「开始自动作答」 click, clicks the correct option text,
//      advances with 下一题 / 保存并下一题, and finally 提交作业 + confirm,
//   4. reports back (`zhs_exam_webview_submitted`) so Rust re-reads the score
//      and persists full-score answers into the local bank.
//
// It never answers when the plan is incomplete and never starts on its own: the
// user has to click the start button after checking the plan summary.

(function () {
  'use strict';

  var CTX = window.__ZHS_EXAM_CTX__ || {};
  if (window.__ZHS_ATTEMPT__) {
    return;
  }
  var A = {
    running: false,
    stopped: false,
    planned: false,
    questions: [],
    plan: null,
    captchaTried: false,
  };
  window.__ZHS_ATTEMPT__ = A;

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

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
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
  var startButton = null;
  var tolerantButton = null;
  var stopButton = null;
  var unresolvedNode = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.id = '__zhs_attempt_overlay';
    overlay.setAttribute(
      'style',
      [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'z-index:2147483647',
        'width:380px',
        'max-height:76vh',
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
      '<div style="font-weight:700;margin-bottom:6px">知到 · 网页作答</div>' +
      '<div id="__zhs_a_status" style="opacity:.9;min-height:36px;white-space:pre-wrap">等待进入试卷页…</div>' +
      '<div id="__zhs_a_unresolved" style="display:none;margin:8px 0;padding:8px;border-radius:8px;background:#3f1d1d;font-size:12px;max-height:140px;overflow:auto"></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0">' +
      '<button id="__zhs_a_start" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:#2563eb;color:#fff">自动作答并提交</button>' +
      '<button id="__zhs_a_tolerant" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:#b91c1c;color:#fff;display:none">容错试做并提交（未解析题任选首项，会得低分）</button>' +
      '<button id="__zhs_a_stop" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:#374151;color:#fff">停止</button>' +
      '</div>' +
      '<div id="__zhs_a_log" style="opacity:.75;font-size:12px;max-height:180px;overflow:auto"></div>' +
      '<div style="opacity:.6;margin-top:8px">若出现滑块/安全验证（网易易盾），请先在窗口内手动完成；通过后自动继续。严格模式只在计划完整时提交；容错试做会把未解析题任选首项先提交本次，之后可再用「网页重做」提交。</div>';
    document.documentElement.appendChild(overlay);
    statusNode = overlay.querySelector('#__zhs_a_status');
    logNode = overlay.querySelector('#__zhs_a_log');
    startButton = overlay.querySelector('#__zhs_a_start');
    tolerantButton = overlay.querySelector('#__zhs_a_tolerant');
    stopButton = overlay.querySelector('#__zhs_a_stop');
    unresolvedNode = overlay.querySelector('#__zhs_a_unresolved');
    startButton.addEventListener('click', function () {
      startMode('strict');
    });
    tolerantButton.addEventListener('click', function () {
      startMode('tolerant');
    });
    stopButton.addEventListener('click', function () {
      A.stopped = true;
      setStatus('已请求停止…');
    });
  }

  function setStatus(text) {
    if (statusNode) statusNode.textContent = text;
  }

  function log(text) {
    if (!logNode) return;
    var line = document.createElement('div');
    line.textContent = text;
    logNode.appendChild(line);
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

  function profileLabel() {
    if (window.__ZHS_PROFILE_PERSISTENT__) {
      return '持久考试配置（首次需在窗口内登录一次）';
    }
    if (window.__ZHS_PROFILE_SHARED__) {
      return '共享登录配置（无需注入 Cookie）';
    }
    return '已注入 Cookie ' + injectedCookieCount() + ' 条';
  }

  /** SPA crashed / no paper: show the diagnostic panel with the last log lines. */
  function showCrashPanel(reason) {
    var recent = '';
    if (logNode) {
      recent = Array.from(logNode.children)
        .slice(-20)
        .map(function (node) {
          return node.textContent || '';
        })
        .join('\n');
    }
    var detail =
      reason +
      '\n\n目标地址：' +
      String(location.href) +
      '\n' +
      profileLabel() +
      '；最近日志：\n' +
      (recent || '（暂无）');
    try {
      if (window.__ZHS_SHOW_ERROR__) window.__ZHS_SHOW_ERROR__('未能读取试卷', detail);
    } catch (e) {
      setStatus('未能读取试卷：' + reason);
    }
  }

  // ---- DOM helpers -------------------------------------------------------

  var QUESTION_SELECTORS = [
    '[class*="question-item" i]',
    '[class*="questionItem" i]',
    '[class*="question-list" i] > *',
    '[class*="questionList" i] > *',
    '.question',
    '[class*="subject-item" i]',
    '[class*="topic-item" i]',
    '[class*="exam-question" i]',
    '[class*="que-item" i]',
  ];
  var OPTION_SELECTORS = [
    '[class*="option" i]',
    '[class*="Option" i]',
    '[role="radio"]',
    '[role="checkbox"]',
    'label',
    'li',
  ];
  var QID_ATTRS = [
    'data-question-id',
    'data-questionid',
    'data-question',
    'data-qid',
    'data-id',
    'questionid',
    'qid',
  ];

  function optionNodes(container) {
    var nodes = [];
    for (var i = 0; i < OPTION_SELECTORS.length; i += 1) {
      var found = Array.from(container.querySelectorAll(OPTION_SELECTORS[i]));
      for (var j = 0; j < found.length; j += 1) {
        var node = found[j];
        if (!isVisible(node)) continue;
        if (nodes.indexOf(node) >= 0) continue;
        // Skip wrappers that contain another candidate (keep the innermost).
        var text = clean(node.innerText || node.textContent);
        if (!text || text.length > 500) continue;
        nodes.push(node);
      }
    }
    return nodes;
  }

  function questionNodes() {
    var candidates = [];
    for (var i = 0; i < QUESTION_SELECTORS.length; i += 1) {
      var found = Array.from(document.querySelectorAll(QUESTION_SELECTORS[i])).filter(isVisible);
      if (found.length > 0) {
        candidates = candidates.concat(found);
      }
    }
    // Keep nodes that look like one question: at least two option-ish children
    // and a non-trivial stem.
    var result = [];
    for (var k = 0; k < candidates.length; k += 1) {
      var node = candidates[k];
      if (result.some(function (other) { return other.contains(node); })) continue;
      var options = optionNodes(node);
      var text = clean(node.innerText || node.textContent);
      if (options.length >= 2 && text.length >= 6) {
        result.push(node);
      }
    }
    return result;
  }

  function questionIdOf(node, index) {
    var el = node;
    for (var depth = 0; depth < 6 && el; depth += 1, el = el.parentElement) {
      for (var i = 0; i < QID_ATTRS.length; i += 1) {
        var value = el.getAttribute && el.getAttribute(QID_ATTRS[i]);
        if (value && /^[A-Za-z0-9_-]{3,}$/.test(value)) return value;
      }
    }
    var html = node.outerHTML || '';
    var match = html.match(/(?:questionId|questionid|qid)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{3,})/);
    return match ? match[1] : 'dom-q-' + index;
  }

  function stemOf(node, options) {
    var clone = node.cloneNode(true);
    // Remove option texts so the stem does not contain answer options.
    var removedSelectors = OPTION_SELECTORS.join(',');
    Array.from(clone.querySelectorAll(removedSelectors)).forEach(function (item) {
      item.remove();
    });
    var text = clean(clone.innerText || clone.textContent);
    if (text) return text;
    // Fallback: full text with option contents stripped.
    var full = clean(node.innerText || node.textContent);
    options.forEach(function (option) {
      if (option.content && full.indexOf(option.content) >= 0) {
        full = full.replace(option.content, ' ');
      }
    });
    return clean(full);
  }

  function kindNameOf(node) {
    var text = clean(node.innerText || node.textContent);
    if (/多选/.test(text)) return '多选题';
    if (/判断/.test(text)) return '判断题';
    if (/填空/.test(text)) return '填空题';
    return '单选题';
  }

  function readQuestions() {
    var nodes = questionNodes();
    var questions = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var options = optionNodes(node).map(function (el, index) {
        var text = clean(el.innerText || el.textContent);
        var id = el.getAttribute('data-option-id') || el.getAttribute('data-id') || null;
        return { id: id, content: text, el: el, index: index };
      });
      // Drop duplicate option nodes that contain the same text.
      var seen = {};
      options = options.filter(function (option) {
        var key = norm(option.content);
        if (!key || seen[key]) return false;
        seen[key] = true;
        return true;
      });
      if (options.length < 2) continue;
      questions.push({
        questionId: questionIdOf(node, i),
        stem: stemOf(node, options),
        kindName: kindNameOf(node),
        score: 0,
        options: options,
        node: node,
      });
    }
    return questions;
  }

  function textNodesMatching(regexp, limit) {
    var nodes = Array.from(document.querySelectorAll('button,a,div,span,li,label'));
    var out = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!isVisible(node)) continue;
      var text = clean(node.innerText || node.textContent);
      if (!text || text.length > 18 || !regexp.test(text)) continue;
      var childSame = Array.from(node.children).some(function (child) {
        return clean(child.innerText || child.textContent) === text;
      });
      if (childSame) continue;
      out.push(node);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  function findNextButton() {
    var buttons = textNodesMatching(/^(下一题|保存并下一题|下一题\/保存|保存并继续|下一题并保存)$/, 4);
    if (buttons.length > 0) return buttons[0];
    return null;
  }

  function findSubmitButton() {
    var buttons = textNodesMatching(/^(提交作业|提交试卷|交卷|提交)$/, 4);
    if (buttons.length > 0) return buttons[0];
    return null;
  }

  function findConfirmButton() {
    // A confirmation dialog appeared after 提交; pick its 确定/确认 button.
    var buttons = textNodesMatching(/^(确定|确认|确认提交|提交|继续)$/, 6);
    for (var i = 0; i < buttons.length; i += 1) {
      if (buttons[i].closest('[class*="dialog" i],[class*="modal" i],[class*="confirm" i],[role="dialog"]')) {
        return buttons[i];
      }
    }
    return null;
  }

  function clickNode(node) {
    try {
      node.scrollIntoView({ block: 'center' });
      node.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  function clickOption(question, content) {
    var target = norm(content);
    if (!target) return false;
    var best = null;
    for (var i = 0; i < question.options.length; i += 1) {
      var option = question.options[i];
      var optionText = norm(option.content);
      if (
        optionText === target ||
        optionText.indexOf(target) >= 0 ||
        target.indexOf(optionText) >= 0
      ) {
        best = option;
        break;
      }
    }
    if (!best) return false;
    // Click the input/label/clickable ancestor when possible.
    var el = best.el;
    var label = el.closest ? el.closest('label') : null;
    var input = el.querySelector ? el.querySelector('input') : null;
    var targetNode = label || input || el;
    return clickNode(targetNode);
  }

  async function waitForQuestionChange(previousQuestion) {
    var deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (A.stopped) return false;
      var current = questionNodes()[0];
      if (!current) return true;
      if (previousQuestion && current.contains(previousQuestion.node)) {
        continue;
      }
      // The page moved on when the current first question is no longer the one
      // we just answered (or its text changed).
      var id = questionIdOf(current, 0);
      if (id !== previousQuestion.questionId) return true;
      if (norm(clean(current.innerText || current.textContent)) !== previousQuestion.text) {
        return true;
      }
    }
    return false;
  }

  // ---- captcha -----------------------------------------------------------

  /** 网易易盾 click-character captcha detection (no coordinate clicking). */
  function captchaVisible() {
    if (document.querySelector('.yidun_bg-img, .yidun_popup, [class*="yidun" i]')) {
      return true;
    }
    var text = clean(document.body ? document.body.innerText : '');
    return /请完成安全验证|请点击.*验证|安全验证/.test(text);
  }

  /**
   * Ask the backend stub to solve the captcha. It currently returns
   * `unsupported`, so the user completes it once manually; the polling loop
   * continues automatically afterwards. We never click random coordinates.
   */
  async function handleCaptchaIfPresent() {
    if (!captchaVisible()) {
      A.captchaTried = false;
      return false;
    }
    if (A.captchaTried) return true;
    A.captchaTried = true;
    setStatus('检测到安全验证，正在自动处理…');
    log('检测到安全验证（网易易盾），尝试自动处理');
    try {
      await invoke('zhs_exam_solve_captcha', {
        windowLabel: CTX.windowLabel || '',
        pngBase64: '',
      });
      log('验证码求解器返回成功');
    } catch (error) {
      log(
        '自动处理验证码不可用：' +
          (error && error.message ? error.message : String(error)),
      );
      setStatus(
        '检测到安全验证：自动处理暂不可用，请在窗口内手动完成一次验证；通过后会自动继续读取试卷。',
      );
    }
    return true;
  }

  // ---- plan --------------------------------------------------------------

  async function loadPlan() {
    if (A.planned || A.running) return;
    ensureOverlay();
    hideLoadingPanel();
    setStatus(
      profileLabel() + '。等待试卷加载（若出现滑块验证请先手动完成）…',
    );
    log(profileLabel());
    var deadline = Date.now() + 180000;
    var questions = [];
    while (Date.now() < deadline) {
      if (A.stopped) return;
      if (captchaVisible()) {
        await handleCaptchaIfPresent();
        await sleep(1500);
        continue;
      }
      A.captchaTried = false;
      questions = readQuestions();
      if (questions.length > 0) break;
      await sleep(2000);
    }
    if (questions.length === 0) {
      setStatus('未能读取到题目：请确认已通过滑块验证并进入试卷页，然后刷新本窗口。');
      showCrashPanel('页面已加载，但 180 秒内没有读到任何题目（可能是 SPA 崩溃、会话失效或页面结构变化）。');
      return;
    }
    A.questions = questions;
    log('共读到 ' + questions.length + ' 题，正在向答案库请求计划…');
    var dto = questions.map(function (question) {
      return {
        questionId: question.questionId,
        stem: question.stem,
        kindName: question.kindName,
        options: question.options.map(function (option) {
          return { id: option.id, content: option.content };
        }),
      };
    });
    try {
      var plan = await invoke('zhs_exam_webview_plan', {
        recruitId: CTX.recruitId,
        courseId: CTX.courseId,
        examId: CTX.examId,
        questions: dto,
      });
      A.plan = plan;
      A.planned = true;
      var unresolved = plan.unresolved || [];
      if (unresolvedNode) {
        if (unresolved.length) {
          unresolvedNode.style.display = 'block';
          unresolvedNode.innerHTML =
            '未解析 ' +
            unresolved.length +
            ' 题（容错试做会任选首项，会得低分）：<br>' +
            unresolved
              .slice(0, 20)
              .map(function (item) {
                return '· ' + escapeHtml(item.stem || item.questionId);
              })
              .join('<br>');
        } else {
          unresolvedNode.style.display = 'none';
          unresolvedNode.innerHTML = '';
        }
      }
      updatePlanButtons();
      if (plan.complete) {
        setStatus(
          '已解析 ' +
            plan.resolved +
            ' / ' +
            plan.total +
            ' 题，计划完整。确认后点击「自动作答并提交」。',
        );
        log('全部题目命中答案库，可严格自动作答。');
      } else {
        setStatus(
          '已解析 ' +
            plan.resolved +
            ' / ' +
            plan.total +
            ' 题，仍有 ' +
            unresolved.length +
            ' 题没有答案。\n严格模式已隐藏。可点红色「容错试做」先提交本次；答案库更新后可「网页重做」再次提交。',
        );
        log(
          '未解析题目 id：' +
            unresolved
              .map(function (item) {
                return item.questionId;
              })
              .join(', '),
        );
      }
    } catch (error) {
      setStatus('读取答题计划失败：' + (error && error.message ? error.message : String(error)));
    }
  }

  // ---- answering ---------------------------------------------------------

  function readScoreFromPage() {
    var text = clean(document.body ? document.body.innerText : '');
    var match = text.match(/(?:得分|成绩|分数)[^0-9]{0,8}(\d{1,3}(?:\.\d+)?)/);
    if (match) return Number(match[1]);
    return null;
  }

  function updatePlanButtons() {
    if (!A.plan || !startButton || !tolerantButton) return;
    if (A.running) {
      startButton.style.display = 'none';
      tolerantButton.style.display = 'none';
      return;
    }
    startButton.style.display = A.plan.complete ? 'inline-block' : 'none';
    tolerantButton.style.display = A.plan.complete ? 'none' : 'inline-block';
  }

  async function startMode(mode) {
    if (A.running || !A.plan) return;
    if (mode === 'strict' && !A.plan.complete) return;
    if (mode === 'tolerant') {
      var unresolvedCount = (A.plan.unresolved || []).length;
      var ok = window.confirm(
        '容错试做会把 ' +
          unresolvedCount +
          ' 道未解析题任选首项（多选只选一项），本次提交会得低分。\n' +
          '目的：先让这场试卷变成「已提交」，之后可在「已提交」里点「网页重做」重新提交。\n\n' +
          '本次会真实提交并可能消耗一次尝试机会。确认开始？',
      );
      if (!ok) return;
    }
    void runAnswering(mode);
  }

  async function runAnswering(mode) {
    if (A.running) return;
    A.running = true;
    A.stopped = false;
    ensureOverlay();
    updatePlanButtons();
    var tolerant = mode === 'tolerant';
    var total = A.questions.length;
    var fallbackCount = 0;
    setStatus(tolerant ? '开始容错试做：未解析题将任选首项…' : '开始自动作答…');

    for (var i = 0; i < A.questions.length; i += 1) {
      if (A.stopped) {
        setStatus('已停止：未提交。请手动检查并决定是否继续。');
        A.running = false;
        updatePlanButtons();
        return;
      }
      var question = A.questions[i];
      var answers = (A.plan.answers[question.questionId] || []).slice();
      var fallback = false;
      if (!answers.length) {
        if (!tolerant) {
          setStatus('第 ' + (i + 1) + ' 题没有可用答案，已停止且未提交。');
          A.running = false;
          updatePlanButtons();
          return;
        }
        if (!question.options.length) {
          setStatus('第 ' + (i + 1) + ' 题在页面中找不到选项，已停止且未提交。');
          A.running = false;
          updatePlanButtons();
          return;
        }
        // Tolerant mode: exactly one option (multi-select also gets one).
        answers = [question.options[0].content];
        fallback = true;
        fallbackCount += 1;
        log(
          '[容错] 第 ' +
            (i + 1) +
            ' 题未解析，任选首项：' +
            question.options[0].content.slice(0, 30),
        );
      }
      // Re-read the live DOM in case the page re-rendered.
      var live = readQuestions()[0];
      if (live && live.questionId === question.questionId) {
        question = live;
      }
      setStatus(
        (fallback ? '容错作答 ' : '作答 ') +
          (i + 1) +
          ' / ' +
          total +
          '：' +
          question.stem.slice(0, 30),
      );
      log(
        '[' +
          (i + 1) +
          '/' +
          total +
          ']' +
          (fallback ? '[容错首项]' : '') +
          ' ' +
          question.stem.slice(0, 40),
      );
      for (var a = 0; a < answers.length; a += 1) {
        if (!clickOption(question, answers[a])) {
          if (tolerant && !fallback && question.options.length) {
            log('[容错] 第 ' + (i + 1) + ' 题题库选项未匹配，改选首项');
            if (!clickOption(question, question.options[0].content)) {
              setStatus('第 ' + (i + 1) + ' 题选项点击失败，已停止且未提交。');
              A.running = false;
              updatePlanButtons();
              return;
            }
            fallback = true;
            fallbackCount += 1;
          } else {
            setStatus(
              '第 ' +
                (i + 1) +
                ' 题找不到选项「' +
                answers[a] +
                '」，已停止且未提交；可在窗口内手动完成。',
            );
            A.running = false;
            updatePlanButtons();
            return;
          }
        }
        await sleep(rand(250, 600));
      }
      await sleep(rand(600, 1200));
      if (i < total - 1) {
        var next = findNextButton();
        if (!next) {
          setStatus('找不到「下一题」按钮，已停止且未提交；请在窗口内手动完成剩余题目。');
          A.running = false;
          updatePlanButtons();
          return;
        }
        var previous = {
          node: question.node,
          questionId: question.questionId,
          text: norm(clean(question.node.innerText || question.node.textContent)),
        };
        clickNode(next);
        var moved = await waitForQuestionChange(previous);
        if (!moved) {
          setStatus('点击「下一题」后页面没有变化，已停止且未提交。');
          A.running = false;
          updatePlanButtons();
          return;
        }
      }
    }

    if (A.stopped) {
      setStatus('已停止：未提交。');
      A.running = false;
      updatePlanButtons();
      return;
    }

    setStatus('全部题目已作答，正在点击「提交作业」…');
    await sleep(rand(800, 1500));
    var submit = findSubmitButton();
    if (!submit) {
      setStatus('找不到「提交作业」按钮，已停止且未提交；请手动检查后提交。');
      A.running = false;
      updatePlanButtons();
      return;
    }
    clickNode(submit);
    await sleep(1200);
    var confirm = findConfirmButton();
    if (confirm) {
      log('确认提交对话框已出现，点击确认。');
      clickNode(confirm);
    }
    setStatus('已提交，正在读取成绩与写入答案库…');
    await sleep(2500);
    var score = readScoreFromPage();
    try {
      var result = await invoke('zhs_exam_webview_submitted', {
        recruitId: CTX.recruitId,
        courseId: CTX.courseId,
        examId: CTX.examId,
        score: score,
      });
      var scoreText =
        result.score === null
          ? '（成绩待刷新）'
          : '得分 ' + result.score + ' / ' + result.total_score;
      var wrong = result.wrongQuestions || [];
      var wrongText =
        wrong.length === 0
          ? '\n全部题目满分。'
          : '\n未得满分 ' +
            wrong.length +
            ' 题（不会自动重试）：\n' +
            wrong
              .slice(0, 8)
              .map(function (item, index) {
                return (
                  '· ' +
                  (item.stem || item.questionId).slice(0, 36) +
                  '（' +
                  item.score +
                  '/' +
                  item.fullScore +
                  '）'
                );
              })
              .join('\n') +
            (wrong.length > 8 ? '\n…' : '');
      wrong.slice(0, 20).forEach(function (item) {
        log('未满分：' + (item.stem || item.questionId).slice(0, 40));
      });
      if (tolerant) {
        setStatus(
          '容错试做已提交！' +
            scoreText +
            '（未解析 ' +
            fallbackCount +
            ' 题任选首项，会得低分）' +
            wrongText +
            '\n\n下一步：关闭本窗口 → 在作业列表「已提交」找到这场 → 点击「网页重做」并提交。',
        );
      } else {
        setStatus(
          '已提交！' +
            scoreText +
            '；写入答案库 ' +
            result.recorded_to_bank +
            ' 题。' +
            wrongText,
        );
      }
    } catch (error) {
      setStatus(
        '已提交，但回读成绩失败：' +
          (error && error.message ? error.message : String(error)) +
          '。可关闭窗口后到「已提交」里查看。',
      );
    }
    A.running = false;
    updatePlanButtons();
  }

  // ---- boot --------------------------------------------------------------

  function boot() {
    ensureOverlay();
    if (!/dohomework/i.test(String(location.hash || ''))) {
      // `about:blank` while the Rust side injects cookies and navigates: keep
      // the loading panel up instead of showing a blank document.
      setStatus('正在加载考试页（Cookie 注入后自动跳转）…');
      setTimeout(boot, 2500);
      return;
    }
    hideLoadingPanel();
    setStatus(
      profileLabel() +
        '。已进入试卷页，若出现滑块验证请手动完成；完成后会自动读取题目。',
    );
    setTimeout(function () {
      void loadPlan();
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
