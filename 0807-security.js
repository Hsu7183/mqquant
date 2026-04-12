(function () {
  'use strict';

  const KEY_OK = '__auth_ok__';
  const SESSION_KEY = '__secure_session_v2__';
  const FAIL_STATE_KEY = '__auth_fail_state_v2__';
  const LOCK_STATE_KEY = '__auth_lock_state_v2__';
  const IDLE_MS = 15 * 60 * 1000;
  const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
  const APPROVED_HOSTS = new Set(['hsu7183.github.io', 'localhost', '127.0.0.1', '[::1]']);

  let idleTimer = null;
  let activityBound = false;

  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
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

  function clearSession() {
    removeKey(sessionStorage, KEY_OK);
    removeKey(sessionStorage, SESSION_KEY);
  }

  function getSession() {
    const session = readJson(sessionStorage, SESSION_KEY);
    return session && typeof session === 'object' ? session : null;
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
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (_) {}
  }

  function getLockState() {
    const state = readJson(localStorage, LOCK_STATE_KEY);
    return { until: Number(state && state.until) || 0 };
  }

  function isLocked() {
    return getLockState().until > nowMs();
  }

  function buildShield(title, detail) {
    const shield = document.getElementById('securityShield');
    if (!shield) return;

    shield.setAttribute('aria-hidden', 'false');
    shield.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'security-shield-card';

    const kicker = document.createElement('p');
    kicker.className = 'security-shield-kicker';
    kicker.textContent = 'SECURE ACCESS';

    const heading = document.createElement('h2');
    heading.className = 'security-shield-title';
    heading.textContent = title;

    const copy = document.createElement('p');
    copy.className = 'security-shield-text';
    copy.textContent = detail;

    const actions = document.createElement('div');
    actions.className = 'security-shield-actions';

    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'btn';
    homeBtn.textContent = '返回安全入口';
    homeBtn.addEventListener('click', () => {
      location.href = 'index.html';
    });

    actions.appendChild(homeBtn);
    card.append(kicker, heading, copy, actions);
    shield.appendChild(card);
  }

  function blockAccess(title, detail) {
    document.body.classList.remove('secure-pending');
    document.body.classList.add('security-blocked');
    buildShield(title, detail);
    window.__mq0807Security = {
      blocked: true,
      reason: title
    };
  }

  function allowAccess() {
    document.body.classList.remove('secure-pending', 'security-blocked');
    const shield = document.getElementById('securityShield');
    if (shield) {
      shield.setAttribute('aria-hidden', 'true');
      shield.innerHTML = '';
    }
    window.__mq0807Security = {
      blocked: false,
      touchSession
    };
  }

  function enforceLogout() {
    clearSession();
    location.href = 'index.html';
  }

  function bindInteractionGuards() {
    if (activityBound) return;
    activityBound = true;

    window.addEventListener('contextmenu', (e) => { e.preventDefault(); }, { capture: true });
    window.addEventListener('copy', (e) => e.preventDefault(), { capture: true });
    window.addEventListener('cut', (e) => e.preventDefault(), { capture: true });
    window.addEventListener('selectstart', (e) => e.preventDefault(), { capture: true });
    window.addEventListener('keydown', (e) => {
      const key = String(e.key || '').toUpperCase();
      if (e.key === 'F12') e.preventDefault();
      if (e.ctrlKey && ['U', 'S', 'P'].includes(key)) e.preventDefault();
      if (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'K'].includes(key)) e.preventDefault();
    }, { capture: true });

    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach((eventName) => {
      document.addEventListener(eventName, () => {
        touchSession();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(enforceLogout, IDLE_MS);
      }, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!hasValidSession()) {
        enforceLogout();
        return;
      }
      touchSession();
    });

    window.addEventListener('storage', (e) => {
      if (e.key === FAIL_STATE_KEY || e.key === LOCK_STATE_KEY) {
        if (isLocked() || !hasValidSession()) {
          enforceLogout();
        }
      }
    });
  }

  function guard() {
    if (window.top !== window.self) {
      blockAccess('已封鎖框架載入', '此分析頁不允許被嵌入其他頁面或外部框架。');
      return false;
    }

    if (!isAllowedRuntime()) {
      blockAccess('未授權來源', '此分析頁僅允許在核准來源與安全入口登入後存取。');
      return false;
    }

    if (isLocked()) {
      clearSession();
      blockAccess('安全鎖定中', '目前登入保護仍在鎖定狀態，請返回安全入口後再試。');
      return false;
    }

    if (!hasValidSession()) {
      clearSession();
      blockAccess('需要安全登入', '請先從 index.html 完成安全登入，再進入此分析頁。');
      return false;
    }

    allowAccess();
    bindInteractionGuards();
    touchSession();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(enforceLogout, IDLE_MS);
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guard, { once: true });
  } else {
    guard();
  }
})();
