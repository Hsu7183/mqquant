(function () {
  'use strict';

  if (window.__mq0807Security && window.__mq0807Security.blocked) {
    return;
  }

  const chartEl = document.getElementById('scoreChart');
  const chartTitleEl = document.getElementById('chartTitle');
  const chipListEl = document.getElementById('periodChipList');
  const groupTabEls = Array.from(document.querySelectorAll('[data-range-group]'));
  const perfResetBtn = document.getElementById('perf-resetBtn');
  const equityPeriodNote = document.getElementById('equityPeriodNote');
  const fileInput = document.getElementById('fileInput');
  const runBtn = document.getElementById('runBtn');
  const resultTable = document.getElementById('resultTable');

  if (!chartEl || !chipListEl || !groupTabEls.length || !perfResetBtn || !window.Chart) {
    return;
  }

  const GROUPS = {
    week: {
      keys: ['week_1', 'week_2', 'week_3', 'week_4'],
      label(span) { return span === 1 ? '當週' : `近${span}週`; }
    },
    month: {
      keys: ['month_1', 'month_2', 'month_3', 'month_4', 'month_5', 'month_6'],
      label(span) { return span === 1 ? '當月' : `近${span}月`; }
    },
    year: {
      keys: ['year_1', 'year_2', 'year_3', 'year_4', 'year_5', 'year_6'],
      label(span) { return span === 1 ? '今年' : `近${span}年`; }
    }
  };

  const RANGE_DEFS = {
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
    full: null,
    signature: '',
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

  function parseDateLabel(label) {
    if (label instanceof Date) return normalizeDate(label);
    const raw = String(label || '').trim();
    if (!raw) return null;

    if (/^\d{8}$/.test(raw)) {
      return normalizeDate(`${raw.slice(0, 4)}/${raw.slice(4, 6)}/${raw.slice(6, 8)}`);
    }
    if (/^\d{4}\/\d{2}\/\d{2}$/.test(raw) || /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return normalizeDate(raw.replace(/-/g, '/'));
    }
    return normalizeDate(raw);
  }

  function startOfWeek(d) {
    const date = normalizeDate(d);
    if (!date) return null;
    const diff = (date.getDay() + 6) % 7;
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

  function fmtRangeDate(d) {
    const date = normalizeDate(d);
    if (!date) return '--';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  function buildRangeCatalog(dates) {
    const cleanDates = (dates || []).map(normalizeDate).filter(Boolean).sort((a, b) => a - b);
    if (!cleanDates.length) return {};

    const anchor = cleanDates[cleanDates.length - 1];
    const catalog = {};

    Object.keys(RANGE_DEFS).forEach((key) => {
      const def = RANGE_DEFS[key];
      let start = null;
      const end = cloneDate(anchor);

      if (def.group === 'week') {
        start = addDays(startOfWeek(anchor), -7 * (def.span - 1));
      } else if (def.group === 'month') {
        start = addMonths(startOfMonth(anchor), -(def.span - 1));
      } else if (def.group === 'year') {
        start = addYears(startOfYear(anchor), -(def.span - 1));
      }

      if (!start || !cleanDates.some((date) => date >= start && date <= end)) {
        return;
      }

      catalog[key] = {
        key,
        group: def.group,
        label: GROUPS[def.group].label(def.span),
        start,
        end,
        range: `${fmtRangeDate(start)} - ${fmtRangeDate(end)}`
      };
    });

    return catalog;
  }

  function setNote(text) {
    if (equityPeriodNote) {
      equityPeriodNote.textContent = text || '';
    }
  }

  function applyTabLabels() {
    groupTabEls.forEach((button) => {
      const group = button.dataset.rangeGroup;
      if (group === 'week') button.textContent = '週';
      if (group === 'month') button.textContent = '月';
      if (group === 'year') button.textContent = '年';
    });
    perfResetBtn.textContent = '全部';
  }

  function renderTabs() {
    applyTabLabels();
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
      chip.textContent = group.label(RANGE_DEFS[key].span);

      const range = state.catalog[key] || null;
      if (!range) {
        chip.disabled = true;
        chip.title = '目前沒有可用資料';
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

  function captureDataset(ds) {
    return {
      type: ds.type || 'line',
      label: ds.label || '',
      borderColor: ds.borderColor,
      backgroundColor: ds.backgroundColor,
      borderWidth: ds.borderWidth,
      pointRadius: ds.pointRadius,
      pointHoverRadius: ds.pointHoverRadius,
      tension: ds.tension,
      fill: ds.fill,
      spanGaps: ds.spanGaps,
      borderDash: Array.isArray(ds.borderDash) ? ds.borderDash.slice() : undefined,
      data: Array.isArray(ds.data) ? ds.data.slice() : []
    };
  }

  function destroyChart() {
    const chart = window.Chart.getChart(chartEl);
    if (chart) chart.destroy();
  }

  function syncFromChart(force) {
    const chart = window.Chart.getChart(chartEl);
    if (!chart) return false;

    const rawLabels = Array.isArray(chart.data.labels) ? chart.data.labels.slice() : [];
    const dates = rawLabels.map(parseDateLabel);
    const signature = JSON.stringify([
      rawLabels.length,
      rawLabels[0] || '',
      rawLabels[rawLabels.length - 1] || '',
      chartTitleEl ? chartTitleEl.textContent : ''
    ]);

    if (!force && state.full && state.signature === signature) {
      return true;
    }

    state.signature = signature;
    state.full = {
      labels: rawLabels,
      dates,
      datasets: chart.data.datasets.map(captureDataset),
      title: chartTitleEl ? chartTitleEl.textContent : '',
      empty: rawLabels.length === 0
    };
    state.catalog = buildRangeCatalog(dates);

    if (state.activeKey !== 'all' && !state.catalog[state.activeKey]) {
      state.activeKey = 'all';
    }
    if (state.activeKey !== 'all' && state.catalog[state.activeKey]) {
      state.activeGroup = state.catalog[state.activeKey].group;
    }

    renderTabs();
    renderChips();
    return true;
  }

  function buildFilteredDatasets(indices) {
    return state.full.datasets.map((dataset) => {
      const next = Object.assign({}, dataset);
      next.data = indices.map((idx) => dataset.data[idx]);
      return next;
    });
  }

  function renderSubset(range) {
    if (!state.full) return false;

    const indices = [];
    state.full.labels.forEach((_, idx) => {
      const date = state.full.dates[idx];
      if (!range || (date && date >= range.start && date <= range.end)) {
        indices.push(idx);
      }
    });

    const labels = indices.map((idx) => state.full.labels[idx]);
    const datasets = buildFilteredDatasets(indices);

    destroyChart();
    const ctx = chartEl.getContext('2d');
    new window.Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(context) {
                const value = context && context.parsed ? context.parsed.y : 0;
                return `${context.dataset.label || '累積損益'}：${Math.round(value || 0).toLocaleString('zh-TW')}`;
              }
            }
          }
        },
        scales: {
          x: {
            offset: false,
            ticks: { maxTicksLimit: 8 },
            title: { display: true, text: '日期' }
          },
          y: {
            title: { display: true, text: '累積損益（金額）' }
          }
        }
      }
    });

    if (chartTitleEl) {
      chartTitleEl.textContent = state.full.title || '頂檔資產曲線（含滑價累積損益）';
    }
    setNote(range ? `目前顯示 ${range.label}｜${range.range}` : '目前顯示全部區間。');
    return true;
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
    return renderSubset(range);
  }

  function clearTimers() {
    state.timers.forEach((id) => window.clearTimeout(id));
    state.timers = [];
  }

  function scheduleSync(baseDelay) {
    clearTimers();
    [baseDelay, baseDelay + 400, baseDelay + 1200].forEach((delay) => {
      const timerId = window.setTimeout(() => {
        if (!syncFromChart(true)) return;
        applyRange(state.activeKey);
      }, delay);
      state.timers.push(timerId);
    });
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

  if (fileInput) fileInput.addEventListener('change', () => scheduleSync(220));
  if (runBtn) runBtn.addEventListener('click', () => scheduleSync(300));
  if (resultTable) {
    resultTable.addEventListener('click', () => scheduleSync(240));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleSync(80), { once: true });
  } else {
    scheduleSync(80);
  }
})();
