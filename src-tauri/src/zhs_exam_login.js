// Injected into the persistent-profile exam window when the user explicitly
// clicks 「登录考试系统」 (or follows the inline link on the exam window).
//
// This window uses the persistent WebView2 profile; one manual login here is
// enough for every later attempt/redo window. The script only reports status
// and never closes the window by itself.

(function () {
  'use strict';

  var CTX = window.__ZHS_EXAM_CTX__ || {};
  if (window.__ZHS_EXAM_LOGIN_OVERLAY__) {
    return;
  }
  window.__ZHS_EXAM_LOGIN_OVERLAY__ = true;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function clean(text) {
    return String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hideLoadingPanel() {
    try {
      if (window.__ZHS_HIDE_LOADING__) window.__ZHS_HIDE_LOADING__();
    } catch (e) {
      /* ignore */
    }
  }

  function isLoginPage() {
    var host = String(location.hostname || '').toLowerCase();
    var path = String(location.pathname || '').toLowerCase();
    return (
      host.indexOf('login') >= 0 ||
      host.indexOf('passport') >= 0 ||
      path.indexOf('login') >= 0 ||
      path.indexOf('passport') >= 0
    );
  }

  function hasAuthenticatedContent() {
    var text = clean(document.body ? document.body.innerText : '');
    return /单元测试|见面课测验|题目数量|申请重做/.test(text);
  }

  function onExamHost() {
    return /onlineexamh5new\.zhihuishu\.com$/i.test(
      String(location.hostname || ''),
    );
  }

  var overlay = null;
  var statusNode = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.id = '__zhs_exam_login_overlay';
    overlay.setAttribute(
      'style',
      [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'z-index:2147483647',
        'width:360px',
        'padding:12px 14px',
        'border-radius:12px',
        'background:#111827',
        'color:#f9fafb',
        'font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif',
        'box-shadow:0 12px 32px rgba(0,0,0,.45)',
      ].join(';'),
    );
    overlay.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">知到 · 考试系统登录</div>' +
      '<div id="__zhs_exam_login_status" style="opacity:.92;min-height:36px;white-space:pre-wrap">正在打开考试列表…</div>' +
      '<div style="opacity:.6;margin-top:8px">首次需要在本窗口登录一次知到；登录后这个窗口会自动继续，且以后不再需要登录。完成后可直接关闭本窗口。</div>';
    document.documentElement.appendChild(overlay);
    statusNode = overlay.querySelector('#__zhs_exam_login_status');
  }

  function setStatus(text) {
    if (statusNode) statusNode.textContent = text;
  }

  async function poll() {
    ensureOverlay();
    var deadline = Date.now() + 10 * 60 * 1000;
    var lastState = '';
    while (Date.now() < deadline) {
      if (onExamHost() || isLoginPage()) {
        hideLoadingPanel();
      }
      ensureOverlay();
      var state = 'waiting';
      if (hasAuthenticatedContent()) {
        state = 'ready';
        setStatus(
          '考试系统已登录/已授权，可以关闭本窗口。以后打开作业/考试窗口无需再登录。',
        );
      } else if (isLoginPage()) {
        state = 'login';
        setStatus(
          '第一次需要在窗口内登录一次知到；登录后这个窗口会自动继续，且以后不再需要登录。',
        );
      } else if (onExamHost()) {
        state = 'loading-list';
        setStatus('正在加载考试列表…（若停在空白页可点窗口刷新）');
      } else {
        setStatus('正在打开考试列表…');
      }
      if (state !== lastState) {
        lastState = state;
        try {
          if (window.__ZHS_PUSH_LOG__) {
            window.__ZHS_PUSH_LOG__('login window state: ' + state + ' ' + location.href);
          }
        } catch (e) {
          /* ignore */
        }
      }
      await sleep(2000);
    }
    setStatus('等待超时：可重新打开「登录考试系统」再试。');
  }

  function boot() {
    ensureOverlay();
    if (!onExamHost() && !isLoginPage()) {
      setTimeout(boot, 1500);
      return;
    }
    hideLoadingPanel();
    void poll();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', function () {
      setTimeout(boot, 800);
    });
  } else {
    setTimeout(boot, 800);
  }
})();
