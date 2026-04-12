(function () {
  'use strict';

  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";

  const PASS_HASH = "0f2b9305e317408510dc9878381e953630ed9fa3d2aadf95f1b8eb47941b18b9";
  const KEY_OK = '__auth_ok__';
  const SESSION_KEY = '__secure_session_v2__';
  const FAIL_STATE_KEY = '__auth_fail_state_v2__';
  const LOCK_STATE_KEY = '__auth_lock_state_v2__';
  const HOME_SLIP_KEY = '__home_slip__';
  const IDLE_MS = 15 * 60 * 1000;
  const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
  const LOCK_MAX_MINUTES = 24 * 60;
  const APPROVED_HOSTS = new Set(['hsu7183.github.io', 'localhost', '127.0.0.1', '[::1]']);
  const APPROVED_SCRIPT_PREFIXES = [
    './shared.js',
    'https://unpkg.com/@supabase/supabase-js@2'
  ];
  const SUPABASE_FUNCTIONS_URL = (() => {
    try {
      const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
      return ref ? `https://${ref}.functions.supabase.co` : '';
    } catch (_) {
      return '';
    }
  })();
  const LOGIN_AUDIT_ENDPOINT = SUPABASE_FUNCTIONS_URL
    ? `${SUPABASE_FUNCTIONS_URL}/log-login-attempt`
    : '';
  const AUDIT_META_KEY = '__login_audit_meta_v1__';

  const DEFAULT_SLIP_PER_SIDE = 2;
  const DEFAULT_POINT_VALUE = 200;
  const DEFAULT_FEE_PER_SIDE = 45;
  const DEFAULT_TAX_RATE = 0.00002;
  const BASE_CAPITAL = 1000000;

  const $ = s => document.querySelector(s);

  const shield = $('#shield');
  const gate = $('#gate');
  const slipGate = $('#slipGate');
  const app = $('#app');

  const pwd = $('#pwd');
  const btnLogin = $('#btnLogin');
  const btnClear = $('#btnClear');
  const err = $('#err');

  const slipInput = $('#slipInput');
  const btnSlipConfirm = $('#btnSlipConfirm');
  const btnSlipDefault = $('#btnSlipDefault');
  const slipErr = $('#slipErr');
  const appSlipBadge = $('#appSlipBadge');

  let lockInfo = null;
  let attemptLastAtValue = null;
  let attemptCountValue = null;
  let attemptLockUntilValue = null;
  let attemptIpValue = null;
  let attemptAuditValue = null;
  let threatPanel = null;
  let threatSummary = null;
  let threatStatusValue = null;
  let threatEventValue = null;
  let threatTimeValue = null;
  let threatIpValue = null;
  let threatCountValue = null;
  let threatLockValue = null;
  let threatDeviceValue = null;
  let threatFingerprintValue = null;
  let threatLocaleValue = null;
  let threatRouteValue = null;
  let shieldTitle = null;
  let shieldText = null;
  let idleTimer = null;
  let activityBound = false;
  let devtoolsWatchArmed = false;

  function setShieldMessage(title, detail) {
    if (!shieldTitle || !shieldText) {
      shield.replaceChildren();

      const card = document.createElement('div');
      card.className = 'shield-card';

      const kicker = document.createElement('p');
      kicker.className = 'shield-kicker';
      kicker.textContent = '防護模式';

      shieldTitle = document.createElement('h3');
      shieldTitle.textContent = title;
      shieldTitle.id = 'shieldTitle';

      shieldText = document.createElement('p');
      shieldText.textContent = detail;
      shieldText.id = 'shieldText';

      card.append(kicker, shieldTitle, shieldText);
      shield.appendChild(card);
    } else {
      shieldTitle.textContent = title;
      shieldText.textContent = detail;
    }

    shield.style.display = 'flex';
  }

  function decorateGateUi() {
    const row = gate.querySelector('.row');
    if (!row) return;

    document.body.classList.add('preauth');
    document.title = '安全入口';
    pwd.placeholder = '請輸入密碼';
    pwd.setAttribute('autocomplete', 'off');
    pwd.setAttribute('spellcheck', 'false');
    pwd.setAttribute('autocapitalize', 'off');
    pwd.setAttribute('inputmode', 'text');
    pwd.setAttribute('maxlength', '128');
    btnLogin.textContent = '進入';
    btnClear.textContent = '清除';

    row.className = 'row gate-actions';
    row.removeAttribute('style');

    const shell = document.createElement('div');
    shell.className = 'gate-shell gate-shell-minimal';

    const panel = document.createElement('div');
    panel.className = 'gate-panel';
    panel.appendChild(row);

    if (err) {
      err.setAttribute('aria-live', 'polite');
      err.textContent = '密碼錯誤，此次嘗試已記錄來源資訊並送出警示。';
      panel.appendChild(err);
    }

    lockInfo = document.createElement('div');
    lockInfo.id = 'lockInfo';
    lockInfo.className = 'gate-status';
    lockInfo.setAttribute('aria-live', 'polite');
    panel.appendChild(lockInfo);

    const threatTitle = document.createElement('p');
    threatTitle.className = 'threat-kicker';
    threatTitle.textContent = 'SECURITY INCIDENT';

    const threatHeadline = document.createElement('h2');
    threatHeadline.className = 'threat-title';
    threatHeadline.textContent = '未授權嘗試已建立稽核事件';

    threatSummary = document.createElement('p');
    threatSummary.className = 'threat-summary';
    threatSummary.textContent = '此區塊會在密碼輸入錯誤後顯示來源與裝置稽核資訊。';

    const threatGrid = document.createElement('div');
    threatGrid.className = 'threat-grid';

    function makeThreatItem(labelText) {
      const item = document.createElement('div');
      item.className = 'threat-item';

      const label = document.createElement('div');
      label.className = 'threat-label';
      label.textContent = labelText;

      const value = document.createElement('div');
      value.className = 'threat-value';
      value.textContent = '待建立';

      item.append(label, value);
      threatGrid.appendChild(item);
      return value;
    }

    threatStatusValue = makeThreatItem('事件狀態');
    threatEventValue = makeThreatItem('事件編號');
    threatTimeValue = makeThreatItem('偵測時間');
    threatIpValue = makeThreatItem('來源 IP');
    threatCountValue = makeThreatItem('累計錯誤次數');
    threatLockValue = makeThreatItem('鎖定至');
    threatDeviceValue = makeThreatItem('裝置環境');
    threatFingerprintValue = makeThreatItem('裝置指紋摘要');
    threatLocaleValue = makeThreatItem('語系 / 時區');
    threatRouteValue = makeThreatItem('存取路徑');

    threatPanel = document.createElement('section');
    threatPanel.className = 'threat-panel';
    threatPanel.hidden = true;

    const threatNote = document.createElement('p');
    threatNote.className = 'threat-note';
    threatNote.textContent = '原始 IP、完整 User-Agent、頁面路徑與請求標頭將保留於後端稽核資料表。';

    threatPanel.append(threatTitle, threatHeadline, threatSummary, threatGrid, threatNote);
    panel.appendChild(threatPanel);

    attemptLastAtValue = null;
    attemptCountValue = null;
    attemptLockUntilValue = null;
    attemptIpValue = null;
    attemptAuditValue = null;

    shell.appendChild(panel);
    gate.replaceChildren(shell);
  }

  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function removeKey(storage, key) {
    try {
      storage.removeItem(key);
    } catch (_) {}
  }

  function nowMs() {
    return Date.now();
  }

  function currentOriginTag() {
    return location.protocol === 'file:' ? 'file://local' : location.origin;
  }

  function isLocalDevHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  }

  function isAllowedRuntime() {
    const host = String(location.hostname || '').toLowerCase();
    const protocol = String(location.protocol || '').toLowerCase();

    if (protocol === 'file:') return true;
    if (!APPROVED_HOSTS.has(host)) return false;
    if (protocol !== 'https:' && !isLocalDevHost(host)) return false;
    return true;
  }

  function clearSession(opts = {}) {
    const preserveSlip = !!opts.preserveSlip;
    removeKey(sessionStorage, KEY_OK);
    removeKey(sessionStorage, SESSION_KEY);
    if (!preserveSlip) removeKey(sessionStorage, HOME_SLIP_KEY);
  }

  function getSession() {
    const session = readJson(sessionStorage, SESSION_KEY);
    return session && typeof session === 'object' ? session : null;
  }

  function createSession() {
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    writeJson(sessionStorage, SESSION_KEY, {
      nonce,
      createdAt: nowMs(),
      lastSeenAt: nowMs(),
      origin: currentOriginTag()
    });
    sessionStorage.setItem(KEY_OK, '1');
  }

  function hasValidSession() {
    if (sessionStorage.getItem(KEY_OK) !== '1') return false;

    const session = getSession();
    if (!session) return false;
    if (session.origin !== currentOriginTag()) return false;
    if (!Number.isFinite(session.createdAt) || !Number.isFinite(session.lastSeenAt)) return false;
    if ((nowMs() - session.createdAt) > SESSION_MAX_AGE_MS) return false;
    if ((nowMs() - session.lastSeenAt) > IDLE_MS) return false;
    return true;
  }

  function touchSession() {
    const session = getSession();
    if (!session) return;
    if ((nowMs() - Number(session.lastSeenAt || 0)) < 5000) return;
    session.lastSeenAt = nowMs();
    writeJson(sessionStorage, SESSION_KEY, session);
  }

  function getLockState() {
    const state = readJson(localStorage, LOCK_STATE_KEY);
    return { until: Number(state && state.until) || 0 };
  }

  function getFailState() {
    const state = readJson(localStorage, FAIL_STATE_KEY);
    return {
      count: Number(state && state.count) || 0,
      lastAt: Number(state && state.lastAt) || 0
    };
  }

  function getAuditMeta() {
    const state = readJson(localStorage, AUDIT_META_KEY);
    return {
      status: String(state && state.status || ''),
      auditId: String(state && state.auditId || ''),
      maskedIp: String(state && state.maskedIp || ''),
      serverAt: Number(state && state.serverAt) || 0,
      message: String(state && state.message || '')
    };
  }

  function setAuditMeta(meta) {
    const current = getAuditMeta();
    writeJson(localStorage, AUDIT_META_KEY, {
      ...current,
      ...meta
    });
    updateLockInfo();
  }

  function formatLocalDateTime(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '尚無資料';
    return new Intl.DateTimeFormat('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(ts));
  }

  function detectBrowser(ua) {
    if (/Edg\//.test(ua)) return 'Microsoft Edge';
    if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'Google Chrome';
    if (/Firefox\//.test(ua)) return 'Mozilla Firefox';
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'Safari';
    return '未知瀏覽器';
  }

  function detectOs(ua) {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';

    if (/Windows/i.test(ua) || /Win/i.test(platform)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(ua) || /Mac/i.test(platform)) return 'macOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Linux/i.test(ua) || /Linux/i.test(platform)) return 'Linux';
    return platform || '未知系統';
  }

  function getScreenLabel() {
    if (window.screen && Number.isFinite(window.screen.width) && Number.isFinite(window.screen.height)) {
      return `${window.screen.width}×${window.screen.height}`;
    }
    return '未知解析度';
  }

  function fnv1aHash(text) {
    let hash = 0x811c9dc5;

    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }

  function buildThreatFingerprint(seed) {
    const forward = fnv1aHash(seed);
    const reverse = fnv1aHash(seed.split('').reverse().join(''));
    return `MQ-${forward.slice(0, 4)}-${forward.slice(4, 8)}-${reverse.slice(0, 4)}`;
  }

  function getThreatContext() {
    const ua = navigator.userAgent || '';
    const browser = detectBrowser(ua);
    const os = detectOs(ua);
    const language = navigator.language || '未知語系';
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '未知時區';
    const screenLabel = getScreenLabel();
    const route = `${location.host || '(file)'}${location.pathname || '/index.html'}`;
    const runtime = `${browser} / ${os} / ${screenLabel}`;
    const fingerprint = buildThreatFingerprint([
      ua,
      language,
      timezone,
      screenLabel,
      route,
      navigator.platform || ''
    ].join('|'));

    return {
      browser,
      os,
      language,
      timezone,
      screenLabel,
      route,
      runtime,
      fingerprint
    };
  }

  function formatAuditStatus(auditMeta) {
    if (auditMeta.status === 'logged') return '後端稽核已寫入';
    if (auditMeta.status === 'pending') return '後端送出中';
    if (auditMeta.status === 'failed') return '本機已記錄，後端待重試';
    return '等待事件建立';
  }

  function formatAuditEventId(auditMeta) {
    return auditMeta.auditId ? `LA-${String(auditMeta.auditId).padStart(6, '0')}` : '待後端回傳';
  }

  function isLocked() {
    return nowMs() < getLockState().until;
  }

  function remainingLockSec() {
    return Math.max(0, Math.ceil((getLockState().until - nowMs()) / 1000));
  }

  function setLock(seconds) {
    writeJson(localStorage, LOCK_STATE_KEY, { until: nowMs() + seconds * 1000 });
  }

  function lockMinutesForFailCount(n) {
    if (n < 3) return 0;
    return Math.min(LOCK_MAX_MINUTES, 5 * Math.pow(2, n - 3));
  }

  function updateLockInfo() {
    if (!lockInfo) return;

    const failState = getFailState();
    const lockState = getLockState();
    const auditMeta = getAuditMeta();
    const threatContext = getThreatContext();
    const locked = isLocked();
    const lockUntilText = lockState.until > nowMs()
      ? formatLocalDateTime(lockState.until)
      : '目前未鎖定';

    if (err) {
      if (locked) {
        err.textContent = `嘗試次數過多，請 ${remainingLockSec()} 秒後再試。`;
        err.style.display = '';
      } else if (failState.count > 0) {
        err.textContent = '密碼錯誤，此次嘗試已記錄來源資訊並送出警示。';
        err.style.display = '';
      } else {
        err.style.display = 'none';
      }
    }

    if (threatPanel) {
      threatPanel.hidden = failState.count === 0;
    }

    if (threatSummary) {
      if (auditMeta.status === 'logged') {
        threatSummary.textContent = '來源資訊已送往後端稽核資料表，原始 IP 與請求標頭已留存。請勿持續嘗試。';
      } else if (auditMeta.status === 'pending') {
        threatSummary.textContent = '正在向後端建立稽核事件，來源 IP 與裝置資訊解析中。';
      } else if (auditMeta.status === 'failed') {
        threatSummary.textContent = '本機端已完成事件記錄；後端暫時未完成寫入，請勿反覆嘗試。';
      } else {
        threatSummary.textContent = '此區塊會在密碼輸入錯誤後顯示來源與裝置稽核資訊。';
      }
    }

    if (threatStatusValue) threatStatusValue.textContent = formatAuditStatus(auditMeta);
    if (threatEventValue) threatEventValue.textContent = formatAuditEventId(auditMeta);
    if (threatTimeValue) threatTimeValue.textContent = formatLocalDateTime(failState.lastAt);
    if (threatIpValue) threatIpValue.textContent = auditMeta.maskedIp || '後端解析中';
    if (threatCountValue) threatCountValue.textContent = `${failState.count} 次`;
    if (threatLockValue) threatLockValue.textContent = lockUntilText;
    if (threatDeviceValue) threatDeviceValue.textContent = threatContext.runtime;
    if (threatFingerprintValue) threatFingerprintValue.textContent = threatContext.fingerprint;
    if (threatLocaleValue) threatLocaleValue.textContent = `${threatContext.language} / ${threatContext.timezone}`;
    if (threatRouteValue) threatRouteValue.textContent = threatContext.route;

    if (locked) {
      const mins = Math.max(1, Math.ceil(remainingLockSec() / 60));
      lockInfo.textContent = `安全鎖定中，約 ${mins} 分鐘後可再次嘗試。`;
      lockInfo.style.color = '#b45309';
      return;
    }

    if (failState.count > 0) {
      lockInfo.textContent = '未授權輸入事件已建立，本裝置與來源資訊正在或已完成留存。';
      lockInfo.style.color = '#991b1b';
      return;
    }

    lockInfo.textContent = '';
    lockInfo.style.color = '#64748b';
  }

  function addFailAndMaybeLock() {
    const nextCount = getFailState().count + 1;
    writeJson(localStorage, FAIL_STATE_KEY, {
      count: nextCount,
      updatedAt: nowMs(),
      lastAt: nowMs()
    });

    const mins = lockMinutesForFailCount(nextCount);
    if (mins > 0) setLock(mins * 60);

    updateLockInfo();
    return {
      count: nextCount,
      lockUntil: getLockState().until
    };
  }

  function resetFails() {
    removeKey(localStorage, FAIL_STATE_KEY);
    removeKey(localStorage, LOCK_STATE_KEY);
    removeKey(localStorage, AUDIT_META_KEY);
    updateLockInfo();
  }

  function shortAuditErrorMessage(err) {
    const raw = String(err && err.message ? err.message : err || '');
    if (!raw) return '後端紀錄送出失敗';
    return raw.length > 36 ? `${raw.slice(0, 36)}…` : raw;
  }

  async function sendLoginAttemptAudit(payload) {
    if (!LOGIN_AUDIT_ENDPOINT) {
      setAuditMeta({ status: 'failed', message: '後端端點未設定' });
      return;
    }

    setAuditMeta({
      status: 'pending',
      auditId: '',
      maskedIp: '',
      serverAt: 0,
      message: ''
    });

    try {
      const res = await fetch(LOGIN_AUDIT_ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok !== true) {
        throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
      }

      setAuditMeta({
        status: 'logged',
        auditId: String(data.auditId || ''),
        maskedIp: String(data.maskedIp || ''),
        serverAt: Date.parse(data.loggedAt || '') || nowMs(),
        message: ''
      });
    } catch (err) {
      setAuditMeta({
        status: 'failed',
        auditId: '',
        message: `後端紀錄失敗：${shortAuditErrorMessage(err)}`
      });
    }
  }

  function reportFailedLogin(reason, failCount, lockUntil) {
    const threatContext = getThreatContext();

    void sendLoginAttemptAudit({
      eventType: 'login_failure',
      reason,
      failCount,
      lockUntil: Number.isFinite(lockUntil) && lockUntil > 0
        ? new Date(lockUntil).toISOString()
        : null,
      clientReportedAt: new Date().toISOString(),
      clientOrigin: currentOriginTag(),
      clientHost: location.host || '(file)',
      pagePath: location.pathname || '/index.html',
      pageHref: location.href,
      userAgent: navigator.userAgent || '',
      clientBrowser: threatContext.browser,
      clientOs: threatContext.os,
      clientLanguage: threatContext.language,
      clientTimeZone: threatContext.timezone,
      clientScreen: threatContext.screenLabel,
      clientFingerprint: threatContext.fingerprint,
      clientRuntime: threatContext.runtime
    });
  }

  function hideProtectedContent() {
    gate.classList.add('hidden');
    slipGate.classList.add('hidden');
    app.classList.add('hidden');
  }

  decorateGateUi();
  document.title = '安全入口';
  setShieldMessage(
    '安全防護已啟動',
    '目前瀏覽環境觸發了安全規則，因此此頁面已被暫時封鎖。'
  );
  shield.style.display = 'none';

  if (window.top !== window.self) {
    try { window.top.location = window.self.location.href; } catch (_) {}
  }

  if (!isAllowedRuntime()) {
    clearSession();
    hideProtectedContent();
    setShieldMessage(
      '執行環境不符',
      '此頁面僅允許在核准來源與可信連線環境下執行，請從 GitHub Pages 或本機開發環境開啟。'
    );
  }

  window.addEventListener('contextmenu', e => { e.preventDefault(); }, { capture: true });
  window.addEventListener('copy', e => e.preventDefault(), { capture: true });
  window.addEventListener('cut', e => e.preventDefault(), { capture: true });
  window.addEventListener('selectstart', e => e.preventDefault(), { capture: true });

  window.addEventListener('keydown', (e) => {
    const K = (e.key || '').toUpperCase();
    if (e.key === 'F12') {
      e.preventDefault();
      setShieldMessage('已封鎖檢視行為', '此保護頁面已停用開發者工具相關快捷鍵。');
    }
    if (e.ctrlKey && ['U', 'S', 'P'].includes(K)) {
      e.preventDefault();
      setShieldMessage('已封鎖檢視行為', '此保護頁面已停用檢視原始碼、儲存與列印快捷鍵。');
    }
    if (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'K'].includes(K)) {
      e.preventDefault();
      setShieldMessage('已封鎖檢視行為', '此保護頁面已停用開發者工具相關快捷鍵。');
    }
  }, { capture: true });

  function startIdleLogout() {
    const kick = () => {
      clearSession();
      location.reload();
    };
    const bump = () => {
      touchSession();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(kick, IDLE_MS);
    };

    if (!activityBound) {
      ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(ev => {
        document.addEventListener(ev, bump, { passive: true });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          if (!hasValidSession()) {
            clearSession();
            location.reload();
            return;
          }
          bump();
        }
      });
      activityBound = true;
    }

    bump();
  }

  function enableDevtoolsWatchAfterLogin() {
    if (devtoolsWatchArmed) return;
    devtoolsWatchArmed = true;

    let suspect = 0;

    function trig() {
      if (++suspect >= 3) {
        setShieldMessage(
          '偵測到異常操作',
          '系統偵測到疑似偵錯或干預行為，頁面已啟動鎖定保護。'
        );
      }
    }

    setInterval(() => {
      if (
        Math.abs(window.outerWidth - window.innerWidth) > 250 ||
        Math.abs(window.outerHeight - window.innerHeight) > 250
      ) {
        trig();
      } else {
        suspect = 0;
      }
    }, 1000);

    (function loop(p) {
      const n = performance.now();
      if (n - p > 1200) trig();
      else suspect = 0;
      requestAnimationFrame(() => loop(performance.now()));
    })(performance.now());
  }

  async function sha256Hex(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function showSlipGate() {
    if (!hasValidSession()) {
      clearSession();
      location.reload();
      return;
    }
    document.body.classList.remove('preauth');
    document.title = '三劍客量化科技 | 滑點設定';
    gate.classList.add('hidden');
    app.classList.add('hidden');
    slipGate.classList.remove('hidden');
    slipErr.style.display = 'none';
    slipInput.value = sessionStorage.getItem(HOME_SLIP_KEY) || String(DEFAULT_SLIP_PER_SIDE);
    slipInput.focus();
    slipInput.select();
  }

  async function enter() {
    err.style.display = 'none';

    if (isLocked()) {
      err.textContent = `嘗試次數過多，請 ${remainingLockSec()} 秒後再試。`;
      err.style.display = '';
      return;
    }

    const v = (pwd.value || '').trim();
    if (!v) {
      err.textContent = '請輸入密碼。';
      err.style.display = '';
      return;
    }

    const t0 = Date.now();

    if (await sha256Hex(v) === PASS_HASH) {
      createSession();
      resetFails();
      removeKey(sessionStorage, HOME_SLIP_KEY);
      showSlipGate();
    } else {
      const delay = 1000 + Math.random() * 600 - (Date.now() - t0);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      const failInfo = addFailAndMaybeLock();
      reportFailedLogin('password_mismatch', failInfo.count, failInfo.lockUntil);
      err.textContent = '密碼錯誤，此次嘗試已記錄來源資訊並送出警示。';
      err.style.display = '';
    }
  }

  function startAppWithSlip(slipPerSide) {
    if (!hasValidSession()) {
      clearSession();
      location.reload();
      return;
    }
    document.body.classList.remove('preauth');
    document.title = '三劍客量化科技 | MQ Quant';
    if (appSlipBadge) {
      appSlipBadge.textContent = `${slipPerSide} 點`;
    }
    sessionStorage.setItem(HOME_SLIP_KEY, String(slipPerSide));
    slipGate.classList.add('hidden');
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    startIdleLogout();
    enableDevtoolsWatchAfterLogin();
    loadDepsAndRun(slipPerSide);
  }

  function confirmSlip(customValue) {
    slipErr.style.display = 'none';
    const n = Number(customValue);
    if (!Number.isFinite(n) || n < 0) {
      slipErr.textContent = '請輸入有效滑點。';
      slipErr.style.display = '';
      return;
    }
    startAppWithSlip(n);
  }

  btnLogin.addEventListener('click', enter);
  btnClear.addEventListener('click', () => {
    pwd.value = '';
    err.style.display = 'none';
    updateLockInfo();
    pwd.focus();
  });

  pwd.addEventListener('keydown', e => {
    if (e.key === 'Enter') enter();
  });

  btnSlipConfirm.addEventListener('click', () => confirmSlip(slipInput.value));
  btnSlipDefault.addEventListener('click', () => confirmSlip(DEFAULT_SLIP_PER_SIDE));
  slipInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmSlip(slipInput.value);
  });

  (function boot() {
    updateLockInfo();
    setInterval(updateLockInfo, 1000);

    window.addEventListener('storage', (e) => {
      if (e.key === FAIL_STATE_KEY || e.key === LOCK_STATE_KEY || e.key === AUDIT_META_KEY) {
        updateLockInfo();
        if (isLocked()) {
          clearSession();
          location.reload();
        }
      }
    });

    if (!isAllowedRuntime()) return;

    if (hasValidSession()) {
      showSlipGate();
    } else {
      clearSession();
      pwd.focus();
    }
  })();

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (!APPROVED_SCRIPT_PREFIXES.some(prefix => String(src || '').startsWith(prefix))) {
        rej(new Error('blocked script source: ' + src));
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.referrerPolicy = 'no-referrer';
      if (/^https:\/\//.test(src)) s.crossOrigin = 'anonymous';
      s.onload = res;
      s.onerror = () => rej(new Error('load fail: ' + src));
      document.body.appendChild(s);
    });
  }

  const CANON_RE = /^(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const CSV_LINE_RE = /^(\d{8}),(\d{5,6}),(\d+(?:\.\d+)?),([^,]+?),/;

  function mapAction(act) {
    if (act === '強平') return '強制平倉';
    if (/^(買進|加碼|再加碼|加碼攤平)$/i.test(act)) return '新買';
    if (/^賣出$/i.test(act)) return '平賣';
    return act;
  }

  function normalizeText(raw) {
    let s = raw.replace(/\ufeff/gi, '').replace(/\u200b|\u200c|\u200d/gi, '');
    s = s
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u3000/g, ' ');
    return s
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  function padTime6(t) {
    t = String(t || '').trim();
    return t.padStart(6, '0').slice(0, 6);
  }

  function canonicalize(txt) {
    const out = [];
    let ok = 0;
    const lines = txt.split('\n');

    for (const l of lines) {
      let m = l.match(EXTRACT_RE);
      if (m) {
        const ts = m[1];
        const px = Number(m[2]);
        out.push(`${ts}.000000 ${px.toFixed(6)} ${m[3]}`);
        ok++;
        continue;
      }

      m = l.match(CSV_LINE_RE);
      if (m) {
        const d8 = m[1];
        const t6 = padTime6(m[2]);
        const px = Number(m[3]);
        const act0 = m[4].trim();
        if (Number.isFinite(px)) {
          out.push(`${d8}${t6}.000000 ${px.toFixed(6)} ${mapAction(act0)}`);
          ok++;
          continue;
        }
      }
    }

    return { canon: out.join('\n'), ok };
  }

  async function blobToCanon(blob) {
    const buf = await blob.arrayBuffer();

    for (const enc of ['utf-8', 'big5', 'utf-16le', 'utf-16be']) {
      try {
        const td = new TextDecoder(enc);
        const norm = normalizeText(td.decode(buf));
        const { canon, ok } = canonicalize(norm);
        if (ok > 0) return { canon, ok };
      } catch (_) {}
    }

    const td = new TextDecoder('utf-8');
    const norm = normalizeText(td.decode(buf));
    const { canon, ok } = canonicalize(norm);
    return { canon, ok };
  }

  function parseCanon(text) {
    const rows = [];
    if (!text) return rows;

    for (const line of text.split('\n')) {
      const m = line.match(CANON_RE);
      if (!m) continue;
      rows.push({
        ts: m[1],
        line
      });
    }

    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }

  function atMidnight(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function mondayOf(d) {
    const x = atMidnight(d);
    const dow = x.getDay();
    const offsetToMonday = (dow + 6) % 7;
    x.setDate(x.getDate() - offsetToMonday);
    return x;
  }

  function sundayOfWeek(d) {
    const m = mondayOf(d);
    const s = new Date(m.getTime());
    s.setDate(s.getDate() + 6);
    return s;
  }

  function addMonthsSameDay(d, n) {
    const x = atMidnight(d);
    const day = x.getDate();
    x.setMonth(x.getMonth() + n);
    x.setDate(day);
    return atMidnight(x);
  }

  function addYearsSameDay(d, n) {
    const x = atMidnight(d);
    const day = x.getDate();
    x.setFullYear(x.getFullYear() + n);
    x.setDate(day);
    return atMidnight(x);
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${dd}`;
  }

  function fmtYmd8(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${dd}`;
  }

  function d8ToDate(s8) {
    return new Date(+s8.slice(0, 4), +s8.slice(4, 6) - 1, +s8.slice(6, 8));
  }

  function getAnchorWeekEnd() {
    const today = new Date();
    return sundayOfWeek(today);
  }

  function makeCoveredSeries(dayMap, coverageStartDate, coverageEndDate) {
    const days = [];
    const vals = [];
    let cur = new Date(coverageStartDate.getTime());

    while (cur <= coverageEndDate) {
      const d8 = fmtYmd8(cur);
      days.push(d8);
      vals.push(dayMap.get(d8) || 0);
      cur.setDate(cur.getDate() + 1);
    }

    return { days, vals };
  }

  function buildPrefix(vals) {
    const p = [0];
    for (const v of vals) p.push(p[p.length - 1] + v);
    return p;
  }

  function sumBetweenCovered(days, pref, startDate, endDate, coverageStartDate, coverageEndDate) {
    if (startDate < coverageStartDate) return null;
    if (endDate > coverageEndDate) return null;
    if (!days.length) return 0;

    const start8 = fmtYmd8(startDate);
    const end8 = fmtYmd8(endDate);

    let i = days.findIndex(d => d >= start8);
    if (i < 0) return null;

    let j = -1;
    for (let idx = days.length - 1; idx >= 0; idx--) {
      if (days[idx] <= end8) {
        j = idx;
        break;
      }
    }

    if (j < i) return 0;
    return pref[j + 1] - pref[i];
  }

  function firstDayOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function lastDayOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }

  function firstDayOfYear(d) {
    return new Date(d.getFullYear(), 0, 1);
  }

  function lastDayOfYear(d) {
    return new Date(d.getFullYear(), 11, 31);
  }

  function weekReturnUser(days, pref, coverageStartDate, coverageEndDate, offsetWeeks) {
    const anchor = getAnchorWeekEnd();
    const end = new Date(anchor.getTime());
    end.setDate(end.getDate() - offsetWeeks * 7);
    const start = mondayOf(end);
    const endOfWeek = sundayOfWeek(start);

    const sum = sumBetweenCovered(days, pref, start, endOfWeek, coverageStartDate, coverageEndDate);
    return {
      ret: (sum == null ? null : sum / BASE_CAPITAL),
      range: `${fmtDate(start)}~${fmtDate(endOfWeek)}`
    };
  }

  function monthReturnUser(days, pref, coverageStartDate, coverageEndDate, offsetMonths) {
    const anchor = getAnchorWeekEnd();
    const target = new Date(anchor.getFullYear(), anchor.getMonth() - offsetMonths, 1);
    const start = firstDayOfMonth(target);
    const end = offsetMonths === 0 ? anchor : lastDayOfMonth(target);

    const sum = sumBetweenCovered(days, pref, start, end, coverageStartDate, coverageEndDate);
    return {
      ret: (sum == null ? null : sum / BASE_CAPITAL),
      range: `${fmtDate(start)}~${fmtDate(end)}`
    };
  }

  function yearReturnUser(days, pref, coverageStartDate, coverageEndDate, offsetYears) {
    const anchor = getAnchorWeekEnd();
    const target = new Date(anchor.getFullYear() - offsetYears, 0, 1);
    const start = firstDayOfYear(target);
    const end = offsetYears === 0 ? anchor : lastDayOfYear(target);

    const sum = sumBetweenCovered(days, pref, start, end, coverageStartDate, coverageEndDate);
    return {
      ret: (sum == null ? null : sum / BASE_CAPITAL),
      range: `${fmtDate(start)}~${fmtDate(end)}`
    };
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('pos', 'neg', 'neu');

    if (v == null) {
      el.textContent = '—';
      el.classList.add('neu');
      return;
    }

    el.textContent = (v * 100).toFixed(2) + '%';
    el.classList.add(v > 0 ? 'pos' : (v < 0 ? 'neg' : 'neu'));
  }

  function setAvg(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('pos', 'neg', 'neu');

    if (v == null) {
      el.textContent = '—';
      el.classList.add('neu');
      return;
    }

    el.textContent = (v * 100).toFixed(2) + '%';
    el.classList.add(v > 0 ? 'pos' : (v < 0 ? 'neg' : 'neu'));
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || '—';
  }

  function setRowLabel(cardKey, rowKey, labelText) {
    const el = document.querySelector(`#row-${rowKey}-${cardKey} .label`);
    if (el) el.textContent = labelText;
  }

  function setCardStatus(key, text, color) {
    const el = document.getElementById(`status-${key}`);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#6b7280';
  }

  function setPeriodText(key, start8, end8) {
    const el = document.getElementById(`period-${key}`);
    if (!el) return;
    if (!start8 || !end8) {
      el.textContent = '—';
      return;
    }
    el.textContent = `${fmtDate(d8ToDate(String(start8)))} - ${fmtDate(d8ToDate(String(end8)))}`;
  }

  function setRowVisible(key, rowKey, visible) {
    const row = document.getElementById(`row-${rowKey}-${key}`);
    if (row) row.style.display = visible ? 'grid' : 'none';
  }

  function applyRowLabels(cardKey) {
    const labels = {
      wk1: '本週',
      wk2: '上週',
      wk3: '2週前',
      wk4: '3週前',
      m1: '本月',
      m2: '上月',
      m3: '2月前',
      m4: '3月前',
      m5: '4月前',
      m6: '5月前',
      y1: '今年',
      y2: '去年',
      y3: '2年前',
      y4: '3年前',
      y5: '4年前',
      y6: '5年前'
    };

    Object.entries(labels).forEach(([rowKey, labelText]) => {
      setRowLabel(cardKey, rowKey, labelText);
    });
  }

  function resetAll(key) {
    const keys = ['wk1','wk2','wk3','wk4','m1','m2','m3','m4','m5','m6','y1','y2','y3','y4','y5','y6'];
    keys.forEach(k => {
      setText(`${k}-range-${key}`, '—');
      setVal(`${k}-${key}`, null);
      setAvg(`${k}-avg-${key}`, null);
      setRowVisible(key, k, true);
    });
  }

  const WANT = {
    "0807": /0807/i,
    "1001": /1001(?!plus)/i,
    "1001pp": /1001plus/i,
    "0313": /0313/i
  };

  const RANGE_RE = /\b(20\d{6})-(20\d{6})\b/;

  function extractRangeFromPath(p) {
    const m = String(p || '').match(RANGE_RE);
    if (!m) return null;
    const a = +m[1];
    const b = +m[2];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
    return { start: a, end: b };
  }

  function addDaysYmd(ymd, days) {
    const s = String(ymd);
    const dt = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    dt.setDate(dt.getDate() + days);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return +(String(y) + m + d);
  }

  function chooseChainByRange(files) {
    const segs = files
      .map(f => {
        const r = extractRangeFromPath(f.fullPath) || extractRangeFromPath(f.name);
        return r ? { ...f, r } : null;
      })
      .filter(Boolean);

    if (!segs.length) return null;

    segs.sort((a, b) => {
      if (a.r.start !== b.r.start) return a.r.start - b.r.start;
      if (a.r.end !== b.r.end) return b.r.end - a.r.end;
      return (b.metadata?.size || 0) - (a.metadata?.size || 0);
    });

    const earliestStart = segs[0].r.start;
    const baseCandidates = segs.filter(s => s.r.start === earliestStart);
    baseCandidates.sort((a, b) => {
      if (a.r.end !== b.r.end) return b.r.end - a.r.end;
      return (b.metadata?.size || 0) - (a.metadata?.size || 0);
    });

    const chain = [baseCandidates[0]];
    let curEnd = chain[0].r.end;

    while (true) {
      const allowStart = addDaysYmd(curEnd, 7);
      const cands = segs.filter(s => s.r.start <= allowStart && s.r.end > curEnd);
      if (!cands.length) break;

      cands.sort((a, b) => {
        if (a.r.end !== b.r.end) return b.r.end - a.r.end;
        const ta = Date.parse(a.updated_at || 0) || 0;
        const tb = Date.parse(b.updated_at || 0) || 0;
        if (ta !== tb) return tb - ta;
        return (b.metadata?.size || 0) - (a.metadata?.size || 0);
      });

      const pick = cands[0];
      if (!chain.some(x => x.fullPath === pick.fullPath)) chain.push(pick);
      curEnd = Math.max(curEnd, pick.r.end);
    }

    chain.sort((a, b) => a.r.start - b.r.start);

    return {
      chain,
      start: Math.min(...chain.map(x => x.r.start)),
      end: Math.max(...chain.map(x => x.r.end))
    };
  }

  function mergeCanonTexts(canonTexts) {
    const seen = new Set();
    const rows = [];

    for (const txt of canonTexts) {
      if (!txt) continue;
      for (const line of String(txt).split('\n')) {
        const m = line.match(CANON_RE);
        if (!m) continue;
        if (seen.has(line)) continue;
        seen.add(line);
        rows.push({ ts: m[1], line });
      }
    }

    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows.map(r => r.line).join('\n');
  }

  function shortErrMsg(e) {
    if (!e) return '未知錯誤';
    const s = String(e && e.message ? e.message : e);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }

  async function loadDepsAndRun(slipPerSide) {
    try {
      await loadScript('https://unpkg.com/@supabase/supabase-js@2');
      await loadScript('./shared.js');
    } catch (e) {
      ['0807','1001','1001pp','0313'].forEach(k => {
        setCardStatus(k, '錯誤：' + shortErrMsg(e), '#b91c1c');
      });
      return;
    }

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
    });

    async function listDir(prefix) {
      const p = (prefix && !prefix.endsWith('/')) ? prefix + '/' : (prefix || '');
      const { data, error } = await sb.storage.from(BUCKET).list(p, {
        limit: 1000,
        sortBy: { column: 'name', order: 'asc' }
      });
      if (error) throw error;
      return (data || []).map(it => ({ ...it, fullPath: p + it.name }));
    }

    async function listDeepN(prefix, depth, maxDepth, out) {
      if (depth > maxDepth) return;
      const entries = await listDir(prefix);
      for (const it of entries) {
        if (!it.id && !it.metadata) {
          await listDeepN(it.fullPath, depth + 1, maxDepth, out);
        } else {
          out.push(it);
        }
      }
    }

    async function listAllFilesByRegex(keyRegex) {
      const all = [];
      await listDeepN('', 0, 8, all);
      return all.filter(it => {
        if (!it.metadata) return false;
        const n = (it.name || '');
        const p = (it.fullPath || '');
        return keyRegex.test(p) || keyRegex.test(n);
      });
    }

    function pickLatestByUpdate(files) {
      if (!files.length) return null;
      const xs = files.slice();
      xs.sort((a, b) => {
        const ta = Date.parse(a.updated_at || 0) || 0;
        const tb = Date.parse(b.updated_at || 0) || 0;
        if (ta !== tb) return tb - ta;
        return (b.metadata?.size || 0) - (a.metadata?.size || 0);
      });
      return xs[0];
    }

    async function downloadCanon(fullPath) {
      const { data, error } = await sb.storage.from(BUCKET).download(fullPath);
      if (error) throw error;
      if (!data) throw new Error('download 無資料');
      return await blobToCanon(data);
    }

    async function resolveMergedForKey(key) {
      const files = await listAllFilesByRegex(WANT[key]);
      if (!files.length) return null;

      const chainInfo = chooseChainByRange(files);

      if (!chainInfo) {
        const latest = pickLatestByUpdate(files);
        if (!latest) return null;
        const canonObj = await downloadCanon(latest.fullPath);
        return {
          canon: canonObj.canon,
          periodStart: null
        };
      }

      const canonTexts = [];
      for (const f of chainInfo.chain) {
        const { canon } = await downloadCanon(f.fullPath);
        canonTexts.push(canon);
      }

      const mergedCanon = mergeCanonTexts(canonTexts);

      return {
        canon: mergedCanon,
        periodStart: String(chainInfo.start)
      };
    }

    function applyVisibleRows(key, coverageStartDate, coverageEndDate) {
      const keys = ['wk1','wk2','wk3','wk4','m1','m2','m3','m4','m5','m6','y1','y2','y3','y4','y5','y6'];
      keys.forEach(rowKey => setRowVisible(key, rowKey, true));
    }

    function dailySeriesFromMerged(mergedTxt, slipPerSide) {
      const parsed = window.SHARED.parseTXT(mergedTxt);
      if (!parsed || !Array.isArray(parsed.rows)) throw new Error('parseTXT 結果異常');

      const report = window.SHARED.buildReport(parsed.rows, {
        slipPerSide,
        pointValue: DEFAULT_POINT_VALUE,
        feePerSide: DEFAULT_FEE_PER_SIDE,
        taxRate: DEFAULT_TAX_RATE
      });

      if (!report || !Array.isArray(report.trades)) throw new Error('buildReport 結果異常');

      const m = new Map();
      for (const t of report.trades) {
        if (!t || t.tsOut == null) continue;
        const gain = typeof t.gainSlip === 'number' ? t.gainSlip : null;
        if (gain == null) continue;
        const d = String(t.tsOut).slice(0, 8);
        m.set(d, (m.get(d) || 0) + gain);
      }

      return m;
    }

    async function fillCard(key) {
      setCardStatus(key, `讀取中（滑點 ${slipPerSide} 點）...`, '#6b7280');

      try {
        resetAll(key);
        applyRowLabels(key);
        const merged = await resolveMergedForKey(key);
        if (!merged || !merged.canon) {
          resetAll(key);
          setPeriodText(key, null, null);
          setCardStatus(key, '無資料', '#b45309');
          return;
        }

        const rows = parseCanon(merged.canon);
        if (!rows.length) throw new Error('canonical 交易列為空');

        const coverageStart8 = merged.periodStart || rows[0].ts.slice(0, 8);
        const coverageStartDate = d8ToDate(coverageStart8);
        const coverageEndDate = getAnchorWeekEnd();

        setPeriodText(key, coverageStart8, fmtYmd8(coverageEndDate));

        const dayMap = dailySeriesFromMerged(merged.canon, slipPerSide);
        const covered = makeCoveredSeries(dayMap, coverageStartDate, coverageEndDate);
        const pref = buildPrefix(covered.vals);

        applyVisibleRows(key, coverageStartDate, coverageEndDate);

        const weekDefs = [['wk1',0],['wk2',1],['wk3',2],['wk4',3]];
        const monthDefs = [['m1',0],['m2',1],['m3',2],['m4',3],['m5',4],['m6',5]];
        const yearDefs = [['y1',0],['y2',1],['y3',2],['y4',3],['y5',4],['y6',5]];

        weekDefs.forEach(([k,n]) => {
          const r = weekReturnUser(covered.days, pref, coverageStartDate, coverageEndDate, n);
          if (r.ret == null) {
            setRowVisible(key, k, false);
            return;
          }
          setText(`${k}-range-${key}`, r.range);
          setVal(`${k}-${key}`, r.ret);
          setAvg(`${k}-avg-${key}`, null);
        });

        monthDefs.forEach(([k,n]) => {
          const r = monthReturnUser(covered.days, pref, coverageStartDate, coverageEndDate, n);
          if (r.ret == null) {
            setRowVisible(key, k, false);
            return;
          }
          setText(`${k}-range-${key}`, r.range);
          setVal(`${k}-${key}`, r.ret);
          setAvg(`${k}-avg-${key}`, null);
        });

        yearDefs.forEach(([k,n]) => {
          const r = yearReturnUser(covered.days, pref, coverageStartDate, coverageEndDate, n);
          if (r.ret == null) {
            setRowVisible(key, k, false);
            return;
          }
          setText(`${k}-range-${key}`, r.range);
          setVal(`${k}-${key}`, r.ret);
          setAvg(`${k}-avg-${key}`, null);
        });

        setCardStatus(key, `已完成（滑點 ${slipPerSide} 點）`, '#15803d');
      } catch (e) {
        console.error('fillCard error', key, e);
        resetAll(key);
        setPeriodText(key, null, null);
        setCardStatus(key, '錯誤：' + shortErrMsg(e), '#b91c1c');
      }
    }

    for (const key of ['0807','1001','1001pp','0313']) {
      await fillCard(key);
    }
  }
})();
