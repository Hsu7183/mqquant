(function () {
  'use strict';

  if (window.__mq0807Security && window.__mq0807Security.blocked) {
    return;
  }

  const chipListEl = document.getElementById('periodChipList');
  const groupTabEls = Array.from(document.querySelectorAll('[data-range-group]'));
  const perfResetBtn = document.getElementById('perf-resetBtn');
  const equityPeriodNote = document.getElementById('equityPeriodNote');
  const fileInput = document.getElementById('fileInput');
  const cloudSelect = document.getElementById('cloudSelect');
  const capitalInput = document.getElementById('capitalInput');
  const slipInput = document.getElementById('slipInput');
  const runBtn = document.getElementById('runBtn');

  if (!chipListEl || !groupTabEls.length || !perfResetBtn) {
    return;
  }

  const GROUPS = {
    week: {
      keys: ['week_1', 'week_2', 'week_3', 'week_4'],
      spanLabel(span) { return span === 1 ? '當週' : `近${span}週`; }
    },
    month: {
      keys: ['month_1', 'month_2', 'month_3', 'month_4', 'month_5', 'month_6'],
      spanLabel(span) { return span === 1 ? '當月' : `近${span}月`; }
    },
    year: {
      keys: ['year_1', 'year_2', 'year_3', 'year_4', 'year_5', 'year_6'],
      spanLabel(span) { return span === 1 ? '今年' : `近${span}年`; }
    }
  };

  const PERIOD_DEFS = {
    week_1: { group: 'week', span: 1 },
    week_2: { group: 'week', span: 2 },
    week_3: { group: 'week', span: 3 },
    week_4: { group: 'week', span: 4 },
    month_1: { group: 'month', span: 1 },
    month_2: { group: 'month', span: 2 },
    month_3: { group: 'month', span: 3 },
    month_4: { group: 'month', span: 4 },
    month_5: { group: 'month', span: 5 },
    month_6: { group: 'month', span: 6 },
    year_1: { group: 'year', span: 1 },
    year_2: { group: 'year', span: 2 },
    year_3: { group: 'year', span: 3 },
    year_4: { group: 'year', span: 4 },
    year_5: { group: 'year', span: 5 },
    year_6: { group: 'year', span: 6 }
  };

  const state = {
    activeGroup: 'week',
    activeKey: 'all',
    catalog: {},
    fullAxis: null,
    timers: []
  };

  function cloneDate(d) {
    return d instanceof Date ? new Date(d.getTime()) : null;
  }

  function normalizeDate(d) {
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  function startOfWeek(d) {
    const date = normalizeDate(d);
    if (!date) return null;
    const day = date.getDay();
    const diff = (day + 6) % 7;
    date.setDate(date.getDate() - diff);
    return date;
  }

  function startOfMonth(d) {
    const date = normalizeDate(d);
    if (!date) return null;
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function startOfYear(d) {
    const date = normalizeDate(d);
    if (!date) return null;
    return new Date(date.getFullYear(), 0, 1);
  }

  function addDays(d, days) {
    const date = normalizeDate(d);
    if (!date) return null;
    date.setDate(date.getDate() + days);
    return date;
  }

  function addMonths(d, delta) {
    const date = normalizeDate(d);
    if (!date) return null;
    return new Date(date.getFullYear(), date.getMonth() + delta, 1);
  }

  function addYears(d, delta) {
    const date = normalizeDate(d);
    if (!date) return null;
    return new Date(date.getFullYear() + delta, 0, 1);
  }

  function hasAxisDataInRange(dates, start, end) {
    return dates.some((d) => {
      const date = normalizeDate(d);
      return date && date >= start && date <= end;
    });
  }

  function fmtRangeDate(d) {
    const date = normalizeDate(d);
    if (!date) return '--';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  function getPeriodLabel(key) {
    const def = PERIOD_DEFS[key];
    const group = def ? GROUPS[def.group] : null;
    return def && group ? group.spanLabel(def.span) : '';
  }

  function buildRangeCatalog() {
    const axis = state.fullAxis;
    const dates = axis && Array.isArray(axis.dates)
      ? axis.dates.map(normalizeDate).filter(Boolean).sort((a, b) => a - b)
      : [];

    if (!dates.length) return {};

    const anchor = dates[dates.length - 1];
    const catalog = {};

    Object.keys(PERIOD_DEFS).forEach((key) => {
      const def = PERIOD_DEFS[key];
      let start = null;
      let end = cloneDate(anchor);

      if (def.group === 'week') {
        const weekStart = startOfWeek(anchor);
        start = addDays(weekStart, -7 * (def.span - 1));
      } else if (def.group === 'month') {
        start = addMonths(startOfMonth(anchor), -(def.span - 1));
      } else if (def.group === 'year') {
        start = addYears(startOfYear(anchor), -(def.span - 1));
      }

      if (!start || !end || !hasAxisDataInRange(dates, start, end)) {
        return;
      }

      catalog[key] = {
        key,
        group: def.group,
        label: getPeriodLabel(key),
        start,
        end,
        range: `${fmtRangeDate(start)} - ${fmtRangeDate(end)}`
      };
    });

    return catalog;
  }

  function setPeriodNote(text) {
    if (equityPeriodNote) {
      equityPeriodNote.textContent = text || '';
    }
  }

  function renderTabs() {
    groupTabEls.forEach((button) => {
      const active = button.dataset.rangeGroup === state.activeGroup;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const isAll = state.activeKey === 'all';
    perfResetBtn.classList.toggle('is-active', isAll);
    perfResetBtn.setAttribute('aria-pressed', isAll ? 'true' : 'false');
  }

  function renderChips() {
    chipListEl.innerHTML = '';
    const group = GROUPS[state.activeGroup] || GROUPS.week;

    group.keys.forEach((key) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'range-chip';
      chip.textContent = getPeriodLabel(key);

      const range = state.catalog[key] || null;
      if (!range) {
        chip.disabled = true;
        chip.title = '目前區間無資料';
      } else {
        chip.title = range.range;
      }

      if (state.activeKey === key) {
        chip.classList.add('is-active');
      }

      chip.addEventListener('click', () => applyRange(key));
      chipListEl.appendChild(chip);
    });
  }

  function captureFullAxis() {
    if (typeof window.__singleTrades_getFullAxisSource !== 'function') {
      state.fullAxis = null;
      state.catalog = {};
      return;
    }

    state.fullAxis = window.__singleTrades_getFullAxisSource();
    state.catalog = buildRangeCatalog();
  }

  function syncState() {
    captureFullAxis();

    if (state.activeKey !== 'all' && !state.catalog[state.activeKey]) {
      state.activeKey = 'all';
    }

    if (state.activeKey !== 'all' && state.catalog[state.activeKey]) {
      state.activeGroup = state.catalog[state.activeKey].group;
    }

    renderTabs();
    renderChips();
  }

  function applyRange(key) {
    const nextKey = key && state.catalog[key] ? key : 'all';
    state.activeKey = nextKey;

    if (nextKey !== 'all' && state.catalog[nextKey]) {
      state.activeGroup = state.catalog[nextKey].group;
    }

    renderTabs();
    renderChips();

    const range = nextKey === 'all' ? null : state.catalog[nextKey];
    let ok = false;

    if (!range && typeof window.__singleTrades_renderAll === 'function') {
      ok = window.__singleTrades_renderAll();
      setPeriodNote('目前顯示全部區間。');
    } else if (range && typeof window.__singleTrades_renderRange === 'function') {
      ok = window.__singleTrades_renderRange(range);
      setPeriodNote(`目前顯示 ${range.label}｜${range.range}`);
    } else {
      setPeriodNote('');
    }

    return ok;
  }

  function clearTimers() {
    state.timers.forEach((id) => window.clearTimeout(id));
    state.timers = [];
  }

  function scheduleRefresh(baseDelay) {
    clearTimers();
    [baseDelay, baseDelay + 320, baseDelay + 760].forEach((delay) => {
      const timerId = window.setTimeout(() => {
        syncState();
        applyRange(state.activeKey);
      }, delay);
      state.timers.push(timerId);
    });
  }

  function bindSourceRefresh(el, eventName, delay) {
    if (!el) return;
    el.addEventListener(eventName, () => scheduleRefresh(delay));
  }

  groupTabEls.forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.dataset.rangeGroup;
      if (!GROUPS[group]) return;
      state.activeGroup = group;
      renderTabs();
      renderChips();
    });
  });

  perfResetBtn.addEventListener('click', () => applyRange('all'));

  bindSourceRefresh(fileInput, 'change', 180);
  bindSourceRefresh(cloudSelect, 'change', 320);
  bindSourceRefresh(runBtn, 'click', 220);
  bindSourceRefresh(capitalInput, 'change', 160);
  bindSourceRefresh(slipInput, 'change', 160);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleRefresh(60), { once: true });
  } else {
    scheduleRefresh(60);
  }
})();
