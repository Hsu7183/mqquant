// 0807.js — 以「次新檔」為基準合併後，直接餵給 single-trades.js（自動計算）
// 分析資料 = 基準全段 + 最新檔的新增；畫面只顯示期間＋KPI＋資產曲線
// ★已移除 manifests/0807.json 的任何讀取/寫入，以消除 DevTools 400 紅字
// ★修正(1)：最新檔若包含「比基準更早的歷史段」，會補在最前面（避免歷史被截掉）
// ★修正(2)：輸出前做「配對清洗」，確保 canonical 行永遠是 開倉→平倉 成對，避免 single-trades.js 後段位移
(function () {
  'use strict';

  if (window.__mq0807Security && window.__mq0807Security.blocked) {
    return;
  }

  if (window.__mq0807Security && typeof window.__mq0807Security.touchSession === 'function') {
    window.__mq0807Security.touchSession();
  }

  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');
  const capitalInputEl = $('#capitalInput');
  const slipInputEl = $('#slipInput');
  const summaryRunBtn = $('#runBtn');
  const chipListEl = $('#periodChipList');
  const groupTabEls = Array.from(document.querySelectorAll('[data-range-group]'));
  const equityPeriodNote = $('#equityPeriodNote');
  const perfResetBtn = $('#perf-resetBtn');

  const summaryState = {
    canon: '',
    start8: '',
    end8: '',
    activeGroup: 'week',
    activeKey: 'all',
    ranges: {},
    chartSource: null,
    chartSlip: null
  };

  const PERIOD_LABELS = {
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

  const WEEK_DEFS = [['wk1', 0], ['wk2', 1], ['wk3', 2], ['wk4', 3]];
  const MONTH_DEFS = [['m1', 0], ['m2', 1], ['m3', 2], ['m4', 3], ['m5', 4], ['m6', 5]];
  const YEAR_DEFS = [['y1', 0], ['y2', 1], ['y3', 2], ['y4', 3], ['y5', 4], ['y6', 5]];
  const CHART_GROUPS = {
    week: {
      keys: ['wk1', 'wk2', 'wk3', 'wk4'],
      spanLabel(span) {
        return span === 1 ? '當週' : `近${span}週`;
      }
    },
    month: {
      keys: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
      spanLabel(span) {
        return span === 1 ? '當月' : `近${span}月`;
      }
    },
    year: {
      keys: ['y1', 'y2', 'y3', 'y4', 'y5', 'y6'],
      spanLabel(span) {
        return span === 1 ? '今年' : `近${span}年`;
      }
    }
  };
  const CHART_PERIOD_DEFS = {
    wk1: { group: 'week', span: 1 },
    wk2: { group: 'week', span: 2 },
    wk3: { group: 'week', span: 3 },
    wk4: { group: 'week', span: 4 },
    m1: { group: 'month', span: 1 },
    m2: { group: 'month', span: 2 },
    m3: { group: 'month', span: 3 },
    m4: { group: 'month', span: 4 },
    m5: { group: 'month', span: 5 },
    m6: { group: 'month', span: 6 },
    y1: { group: 'year', span: 1 },
    y2: { group: 'year', span: 2 },
    y3: { group: 'year', span: 3 },
    y4: { group: 'year', span: 4 },
    y5: { group: 'year', span: 5 },
    y6: { group: 'year', span: 6 }
  };
  const DEFAULT_POINT_VALUE = 200;
  const DEFAULT_FEE_PER_SIDE = 45;
  const DEFAULT_TAX_RATE = 0.00002;

  let summaryEventsBound = false;
  let rangeEventsBound = false;
  let rangeSyncTimers = [];

  if (status) status.style.whiteSpace = 'pre-wrap';

  // Supabase 設定（與其他頁一致）
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  if (!window.supabase) {
    console.error('Supabase SDK 未載入');
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const STRATEGY_LABEL = '0313';
  const WANT = /0313/i;

  // canonical 3 欄行
  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  function pubUrl(path) {
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || '#';
  }

  async function listOnce(prefix) {
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, {
      limit : 1000,
      sortBy: { column: 'name', order: 'asc' }
    });
    if (error) throw new Error(error.message);
    return (data || [])
      .filter(it => !(it.id === null && !it.metadata))
      .map(it => ({
        name     : it.name,
        fullPath : p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size     : it.metadata?.size || 0
      }));
  }

  async function listCandidates() {
    const u      = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }

  function lastDateScore(name) {
    const m = String(name).match(/\b(20\d{6})\b/g);
    if (!m || !m.length) return 0;
    return Math.max(...m.map(s => +s || 0));
  }

  // ===== 文字正規化 & canonical 行抽取 =====
  function normalizeText(raw) {
    let s = raw
      .replace(/\ufeff/gi, '')                  // BOM
      .replace(/\u200b|\u200c|\u200d/gi, '')    // 零寬字元
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');// 控制碼

    s = s.replace(/\r\n?/g, '\n')
         .replace(/\u3000/g, ' ');

    const lines = s
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return lines.join('\n');
  }

  function canonicalize(txt) {
    const out = [];
    const lines = (txt || '').split('\n');
    let ok = 0;

    for (const l of lines) {
      const m = l.match(EXTRACT_RE);
      if (m) {
        const ts  = m[1];
        const pxN = Number(m[2]);
        const px6 = Number.isFinite(pxN) ? pxN.toFixed(6) : m[2];
        const act = m[3];
        out.push(`${ts}.000000 ${px6} ${act}`);
        ok++;
      }
    }
    return { canon: out.join('\n'), ok };
  }

  async function fetchSmart(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();

    for (const enc of ['utf-8', 'big5', 'utf-16le', 'utf-16be']) {
      try {
        const td   = new TextDecoder(enc, { fatal: false });
        const norm = normalizeText(td.decode(buf));
        const { canon, ok } = canonicalize(norm);
        if (ok > 0) return { enc, canon, ok };
      } catch (e) {}
    }

    const td   = new TextDecoder('utf-8');
    const norm = normalizeText(td.decode(buf));
    const { canon, ok } = canonicalize(norm);
    return { enc: 'utf-8', canon, ok };
  }

  function parseCanon(text) {
    const rows = [];
    if (!text) return rows;
    for (const line of text.split('\n')) {
      const m = line.match(CANON_RE);
      if (m) rows.push({ ts: m[1], line, act: m[3] });
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }

  // ===== 合併（補頭段 + 補尾段）=====
  // combined = (latest 補在基準前面的更早段) + base 全部 + (latest 補在基準後面的新增尾段)
  function mergeByBaseline(baseText, latestText) {
    const A = parseCanon(baseText);    // base
    const B = parseCanon(latestText);  // latest

    const baseMinTs = A.length ? A[0].ts : (B.length ? B[0].ts : '');
    const baseMaxTs = A.length ? A[A.length - 1].ts : '';

    const head = (baseMinTs)
      ? B.filter(x => x.ts < baseMinTs).map(x => x.line)
      : [];

    const tail = (baseMaxTs)
      ? B.filter(x => x.ts > baseMaxTs).map(x => x.line)
      : B.map(x => x.line);

    const mergedLines = [...head, ...A.map(x => x.line), ...tail];

    const start8 = mergedLines.length
      ? mergedLines[0].match(CANON_RE)[1].slice(0, 8)
      : '';

    const end8 = mergedLines.length
      ? mergedLines[mergedLines.length - 1].match(CANON_RE)[1].slice(0, 8)
      : start8;

    return {
      combined: mergedLines.join('\n'),
      start8,
      end8
    };
  }

  // ===== 配對清洗：確保 canonical 行為「開倉→平倉」成對，避免後段位移 =====
  function sanitizeCanonPaired(canonText) {
    const rows = parseCanon(canonText);
    if (!rows.length) return { canon: '', start8: '', end8: '' };

    const isEntry = (a) => (a === '新買' || a === '新賣');
    const isExit  = (a) => (a === '平賣' || a === '平買' || a === '強制平倉');

    const out = [];
    let hasOpen = false;

    for (const r of rows) {
      const act = r.act;

      if (!hasOpen) {
        // 沒有 open：只接受開倉，丟掉孤兒平倉
        if (isEntry(act)) {
          out.push(r.line);
          hasOpen = true;
        }
        continue;
      }

      // 有 open：只接受平倉，若又遇到開倉則丟掉（避免連續開倉造成位移）
      if (isExit(act)) {
        out.push(r.line);
        hasOpen = false;
      } else if (isEntry(act)) {
        // drop
      }
    }

    // 若最後還有 open 沒平倉，直接丟掉最後那筆開倉，確保輸出為偶數成對
    if (out.length % 2 === 1) out.pop();

    const start8 = out.length ? out[0].match(CANON_RE)[1].slice(0, 8) : '';
    const end8   = out.length ? out[out.length - 1].match(CANON_RE)[1].slice(0, 8) : start8;

    return { canon: out.join('\n'), start8, end8 };
  }

  // ===== 把合併後內容餵給 single-trades.js =====
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  function fmtYmd8(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  function d8ToDate(s8) {
    return new Date(+s8.slice(0, 4), +s8.slice(4, 6) - 1, +s8.slice(6, 8));
  }

  function ts14ToDate(ts14) {
    const clean = String(ts14 || '').replace(/\D/g, '');
    if (clean.length < 8) return null;
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10) - 1;
    const d = parseInt(clean.slice(6, 8), 10);
    const hh = clean.length >= 10 ? parseInt(clean.slice(8, 10), 10) : 0;
    const mm = clean.length >= 12 ? parseInt(clean.slice(10, 12), 10) : 0;
    return new Date(y, m, d, hh, mm, 0);
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

  function dateWeekKey(date) {
    const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  function getAnchorWeekEnd() {
    return sundayOfWeek(new Date());
  }

  function buildPrefix(vals) {
    const prefix = [0];
    for (const v of vals) prefix.push(prefix[prefix.length - 1] + v);
    return prefix;
  }

  function buildTickMap(dates) {
    const tickMap = {};
    if (!dates.length) return tickMap;

    const lastIndex = dates.length - 1;
    [0, 0.25, 0.5, 0.75, 1].forEach((ratio) => {
      const idx = Math.round(lastIndex * ratio);
      const date = dates[idx];
      if (!date) return;
      tickMap[idx] = `${date.getFullYear()}/${date.getMonth() + 1}`;
    });

    return tickMap;
  }

  function getChartInstance(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart || typeof window.Chart.getChart !== 'function') return null;
    return window.Chart.getChart(canvas) || null;
  }

  function makeCoveredSeries(dayMap, coverageStartDate, coverageEndDate) {
    const days = [];
    const vals = [];
    const cur = new Date(coverageStartDate.getTime());

    while (cur <= coverageEndDate) {
      const d8 = fmtYmd8(cur);
      days.push(d8);
      vals.push(dayMap.get(d8) || 0);
      cur.setDate(cur.getDate() + 1);
    }

    return { days, vals };
  }

  function sumBetweenCovered(days, prefix, startDate, endDate, coverageStartDate, coverageEndDate) {
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
    return prefix[j + 1] - prefix[i];
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

  function weekReturnUser(days, prefix, coverageStartDate, coverageEndDate, offsetWeeks, capitalBase) {
    const anchor = getAnchorWeekEnd();
    const end = new Date(anchor.getTime());
    end.setDate(end.getDate() - offsetWeeks * 7);
    const start = mondayOf(end);
    const endOfWeek = sundayOfWeek(start);
    const sum = sumBetweenCovered(days, prefix, start, endOfWeek, coverageStartDate, coverageEndDate);

    return {
      start,
      end: endOfWeek,
      ret: (sum == null ? null : sum / capitalBase),
      range: `${fmtDate(start)}~${fmtDate(endOfWeek)}`
    };
  }

  function monthReturnUser(days, prefix, coverageStartDate, coverageEndDate, offsetMonths, capitalBase) {
    const anchor = getAnchorWeekEnd();
    const target = new Date(anchor.getFullYear(), anchor.getMonth() - offsetMonths, 1);
    const start = firstDayOfMonth(target);
    const end = offsetMonths === 0 ? anchor : lastDayOfMonth(target);
    const sum = sumBetweenCovered(days, prefix, start, end, coverageStartDate, coverageEndDate);

    return {
      start,
      end,
      ret: (sum == null ? null : sum / capitalBase),
      range: `${fmtDate(start)}~${fmtDate(end)}`
    };
  }

  function yearReturnUser(days, prefix, coverageStartDate, coverageEndDate, offsetYears, capitalBase) {
    const anchor = getAnchorWeekEnd();
    const target = new Date(anchor.getFullYear() - offsetYears, 0, 1);
    const start = firstDayOfYear(target);
    const end = offsetYears === 0 ? anchor : lastDayOfYear(target);
    const sum = sumBetweenCovered(days, prefix, start, end, coverageStartDate, coverageEndDate);

    return {
      start,
      end,
      ret: (sum == null ? null : sum / capitalBase),
      range: `${fmtDate(start)}~${fmtDate(end)}`
    };
  }

  function buildWeekWindow(days, prefix, coverageStartDate, coverageEndDate, span, capitalBase) {
    const anchor = getAnchorWeekEnd();
    const start = mondayOf(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - (span - 1) * 7));
    const sum = sumBetweenCovered(days, prefix, start, anchor, coverageStartDate, coverageEndDate);

    return {
      start,
      end: anchor,
      ret: (sum == null ? null : sum / capitalBase),
      range: `${fmtDate(start)}~${fmtDate(anchor)}`
    };
  }

  function buildMonthWindow(days, prefix, coverageStartDate, coverageEndDate, span, capitalBase) {
    const anchor = getAnchorWeekEnd();
    const start = firstDayOfMonth(new Date(anchor.getFullYear(), anchor.getMonth() - (span - 1), 1));
    const sum = sumBetweenCovered(days, prefix, start, anchor, coverageStartDate, coverageEndDate);

    return {
      start,
      end: anchor,
      ret: (sum == null ? null : sum / capitalBase),
      range: `${fmtDate(start)}~${fmtDate(anchor)}`
    };
  }

  function buildYearWindow(days, prefix, coverageStartDate, coverageEndDate, span, capitalBase) {
    const anchor = getAnchorWeekEnd();
    const start = firstDayOfYear(new Date(anchor.getFullYear() - (span - 1), 0, 1));
    const sum = sumBetweenCovered(days, prefix, start, anchor, coverageStartDate, coverageEndDate);

    return {
      start,
      end: anchor,
      ret: (sum == null ? null : sum / capitalBase),
      range: `${fmtDate(start)}~${fmtDate(anchor)}`
    };
  }

  function setPerfVisible(key, visible) {
    const row = document.getElementById(`perf-row-${key}`);
    if (row) row.style.display = visible ? '' : 'none';
  }

  function setPerfLabel(key, text) {
    const el = document.getElementById(`perf-label-${key}`);
    if (el) el.textContent = text || '--';
  }

  function setPerfRange(key, text) {
    const el = document.getElementById(`perf-range-${key}`);
    if (el) el.textContent = text || '--';
  }

  function setPerfValue(key, value) {
    const el = document.getElementById(`perf-val-${key}`);
    if (!el) return;

    el.classList.remove('pos', 'neg', 'neu');

    if (value == null || !Number.isFinite(value)) {
      el.textContent = '--';
      el.classList.add('neu');
      return;
    }

    el.textContent = (value * 100).toFixed(2) + '%';
    el.classList.add(value > 0 ? 'pos' : (value < 0 ? 'neg' : 'neu'));
  }

  function updatePeriodNote(text) {
    if (equityPeriodNote) equityPeriodNote.textContent = text;
  }

  function getChartPeriodLabel(key) {
    const def = CHART_PERIOD_DEFS[key];
    if (!def || !CHART_GROUPS[def.group]) return '';
    return CHART_GROUPS[def.group].spanLabel(def.span);
  }

  function renderChartRangeTabs() {
    groupTabEls.forEach((button) => {
      const group = button.dataset.rangeGroup;
      const active = group === summaryState.activeGroup;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (perfResetBtn) {
      const isAll = summaryState.activeKey === 'all';
      perfResetBtn.classList.toggle('is-active', isAll);
      perfResetBtn.setAttribute('aria-pressed', isAll ? 'true' : 'false');
    }
  }

  function renderChartRangeChips() {
    if (!chipListEl) return;

    chipListEl.innerHTML = '';
    const group = CHART_GROUPS[summaryState.activeGroup] || CHART_GROUPS.week;

    group.keys.forEach((key) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'range-chip';
      button.dataset.rangeKey = key;
      button.textContent = getChartPeriodLabel(key);

      const range = summaryState.ranges[key] || null;
      if (!range) {
        button.disabled = true;
        button.title = '目前資料不足';
      } else {
        button.title = range.range;
      }

      if (summaryState.activeKey === key) {
        button.classList.add('is-active');
      }

      button.addEventListener('click', () => applyChartRange(key));
      chipListEl.appendChild(button);
    });
  }

  function setActiveChartRangeGroup(group) {
    if (!CHART_GROUPS[group]) return;
    summaryState.activeGroup = group;
    renderChartRangeTabs();
    renderChartRangeChips();
  }

  function buildChartRanges() {
    if (!summaryState.canon) return {};

    const rows = parseCanon(summaryState.canon);
    if (!rows.length) return {};

    const coverageStart8 = summaryState.start8 || rows[0].ts.slice(0, 8);
    const coverageStartDate = d8ToDate(coverageStart8);
    const coverageEndDate = getAnchorWeekEnd();
    const capitalBase = getCurrentCapital();
    const slipPerSide = getCurrentSlip();
    const dayMap = dailySeriesFromMerged(summaryState.canon, slipPerSide);
    const covered = makeCoveredSeries(dayMap, coverageStartDate, coverageEndDate);
    const prefix = buildPrefix(covered.vals);
    const ranges = {};

    Object.keys(CHART_PERIOD_DEFS).forEach((key) => {
      const def = CHART_PERIOD_DEFS[key];
      let result = null;

      if (def.group === 'week') {
        result = buildWeekWindow(covered.days, prefix, coverageStartDate, coverageEndDate, def.span, capitalBase);
      } else if (def.group === 'month') {
        result = buildMonthWindow(covered.days, prefix, coverageStartDate, coverageEndDate, def.span, capitalBase);
      } else if (def.group === 'year') {
        result = buildYearWindow(covered.days, prefix, coverageStartDate, coverageEndDate, def.span, capitalBase);
      }

      if (!result || result.ret == null) return;
      ranges[key] = {
        key,
        group: def.group,
        label: getChartPeriodLabel(key),
        start: result.start,
        end: result.end,
        range: result.range
      };
    });

    return ranges;
  }

  function syncChartRangeState() {
    summaryState.ranges = buildChartRanges();

    if (summaryState.activeKey !== 'all' && !summaryState.ranges[summaryState.activeKey]) {
      summaryState.activeKey = 'all';
    }

    if (summaryState.activeKey !== 'all' && summaryState.ranges[summaryState.activeKey]) {
      summaryState.activeGroup = summaryState.ranges[summaryState.activeKey].group;
    }

    renderChartRangeTabs();
    renderChartRangeChips();
  }

  function applyChartRange(key) {
    const nextKey = key && summaryState.ranges[key] ? key : 'all';
    summaryState.activeKey = nextKey;

    if (nextKey !== 'all' && summaryState.ranges[nextKey]) {
      summaryState.activeGroup = summaryState.ranges[nextKey].group;
    }

    renderChartRangeTabs();
    renderChartRangeChips();

    const range = nextKey === 'all' ? null : summaryState.ranges[nextKey];
    let ok = false;
    let renderErr = null;

    try {
      if (!range && typeof window.__singleTrades_renderAll === 'function') {
        ok = window.__singleTrades_renderAll();
      } else if (range && typeof window.__singleTrades_renderRange === 'function') {
        ok = window.__singleTrades_renderRange(range);
      }
    } catch (err) {
      renderErr = err;
      console.error('0807 applyChartRange render error', err);
      window.__mq0807Debug = window.__mq0807Debug || {};
      window.__mq0807Debug.lastRenderError = String(err && err.message ? err.message : err);
    } finally {
      scheduleWeeklySync(range);
    }

    if (nextKey === 'all') {
      updatePeriodNote('目前顯示全部區間。');
    } else if (range) {
      updatePeriodNote(`目前顯示 ${range.label}，區間為 ${range.range}。`);
    }

    return renderErr ? false : ok;
  }

  function clearRangeSyncTimers() {
    rangeSyncTimers.forEach((timerId) => window.clearTimeout(timerId));
    rangeSyncTimers = [];
  }

  function scheduleChartRangeRefresh(baseDelay) {
    clearRangeSyncTimers();
    [baseDelay, baseDelay + 650].forEach((delay) => {
      const timerId = window.setTimeout(() => {
        try {
          syncChartRangeState();
          applyChartRange(summaryState.activeKey);
        } catch (err) {
          console.error('0807 chart range refresh error', err);
        }
      }, delay);
      rangeSyncTimers.push(timerId);
    });
  }

  function resetPerformanceSummary() {
    Object.entries(PERIOD_LABELS).forEach(([key, label]) => {
      setPerfLabel(key, label);
      setPerfRange(key, '--');
      setPerfValue(key, null);
      setPerfVisible(key, true);
    });
  }

  function getCurrentCapital() {
    const value = Number(capitalInputEl && capitalInputEl.value);
    return (Number.isFinite(value) && value > 0) ? value : 1000000;
  }

  function getCurrentSlip() {
    const value = Number(slipInputEl && slipInputEl.value);
    return Number.isFinite(value) ? value : 2;
  }

  function dailySeriesFromMerged(mergedTxt, slipPerSide) {
    if (!window.SHARED || !window.SHARED.parseTXT || !window.SHARED.buildReport) {
      throw new Error('shared.js 未載入');
    }

    const parsed = window.SHARED.parseTXT(mergedTxt);
    if (!parsed || !Array.isArray(parsed.rows)) {
      throw new Error('parseTXT 結果異常');
    }

    const report = window.SHARED.buildReport(parsed.rows, {
      slipPerSide,
      pointValue: DEFAULT_POINT_VALUE,
      feePerSide: DEFAULT_FEE_PER_SIDE,
      taxRate: DEFAULT_TAX_RATE
    });

    if (!report || !Array.isArray(report.trades)) {
      throw new Error('buildReport 結果異常');
    }

    const dayMap = new Map();
    for (const trade of report.trades) {
      if (!trade || !trade.tsOut) continue;
      const gain = typeof trade.gainSlip === 'number' ? trade.gainSlip : null;
      if (gain == null) continue;
      const d8 = String(trade.tsOut).slice(0, 8);
      dayMap.set(d8, (dayMap.get(d8) || 0) + gain);
    }

    return dayMap;
  }

  function buildWeeklyChartSource() {
    const slipPerSide = getCurrentSlip();
    if (
      summaryState.chartSource &&
      summaryState.chartSlip === slipPerSide &&
      Array.isArray(summaryState.chartSource.dates) &&
      Array.isArray(summaryState.chartSource.pnls)
    ) {
      return {
        dates: summaryState.chartSource.dates.slice(),
        pnls: summaryState.chartSource.pnls.slice()
      };
    }

    if (!summaryState.canon || !window.SHARED || !window.SHARED.parseTXT || !window.SHARED.buildReport) {
      return null;
    }

    const parsed = window.SHARED.parseTXT(summaryState.canon);
    if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) return null;

    const report = window.SHARED.buildReport(parsed.rows, {
      slipPerSide,
      pointValue: DEFAULT_POINT_VALUE,
      feePerSide: DEFAULT_FEE_PER_SIDE,
      taxRate: DEFAULT_TAX_RATE
    });
    if (!report || !Array.isArray(report.trades) || !report.trades.length) return null;

    const weekMap = {};
    report.trades.forEach((trade) => {
      const date = ts14ToDate(trade.tsOut);
      if (!date) return;
      const weekKey = dateWeekKey(date);
      if (!weekMap[weekKey]) {
        weekMap[weekKey] = { date, sum: 0 };
      } else if (date > weekMap[weekKey].date) {
        weekMap[weekKey].date = date;
      }
      weekMap[weekKey].sum += trade.gainSlip || 0;
    });

    const dates = [];
    const pnls = [];
    Object.keys(weekMap).sort().forEach((weekKey) => {
      dates.push(weekMap[weekKey].date);
      pnls.push(weekMap[weekKey].sum);
    });

    summaryState.chartSlip = slipPerSide;
    summaryState.chartSource = {
      dates: dates.slice(),
      pnls: pnls.slice()
    };

    return {
      dates,
      pnls
    };
  }

  function filterWeeklyChartSource(source, range) {
    if (!source) return null;
    if (!range) {
      return {
        dates: source.dates.slice(),
        pnls: source.pnls.slice()
      };
    }

    const dates = [];
    const pnls = [];
    source.dates.forEach((date, index) => {
      if (!date) return;
      const time = date.getTime();
      if (time >= range.start.getTime() && time <= range.end.getTime()) {
        dates.push(date);
        pnls.push(source.pnls[index]);
      }
    });

    return { dates, pnls };
  }

  function syncWeeklyChartToCurrentRange(range) {
    const oldCanvas = document.getElementById('weeklyPnlChart');
    if (!oldCanvas || !window.Chart) return false;

    const existingChart = typeof window.Chart.getChart === 'function'
      ? window.Chart.getChart(oldCanvas)
      : null;
    if (existingChart) {
      try {
        existingChart.destroy();
      } catch (err) {
        console.warn('0807 weekly chart destroy warning', err);
      }
    }

    const parent = oldCanvas.parentNode;
    const canvas = oldCanvas.cloneNode(false);
    canvas.id = 'weeklyPnlChart';
    if (parent) {
      parent.replaceChild(canvas, oldCanvas);
    }

    const source = filterWeeklyChartSource(buildWeeklyChartSource(), range);
    if (!source || !Array.isArray(source.dates) || !source.dates.length) {
      return false;
    }

    const labels = source.dates.map((_, index) => String(index + 1));
    const tickMap = buildTickMap(source.dates);
    const pnls = source.pnls.map((value) => (
      Number.isFinite(Number(value)) ? Number(value) : null
    ));
    const barColors = pnls.map((value) => {
      if (!Number.isFinite(value) || value === 0) return 'rgba(0,0,0,0)';
      return value > 0 ? 'rgba(220,0,0,0.8)' : 'rgba(0,150,0,0.8)';
    });
    const borderColors = pnls.map((value) => {
      if (!Number.isFinite(value) || value === 0) return 'rgba(0,0,0,0)';
      return value > 0 ? 'rgba(220,0,0,1)' : 'rgba(0,150,0,1)';
    });
    const equityChart = typeof window.Chart.getChart === 'function'
      ? window.Chart.getChart(document.getElementById('equityChart'))
      : null;
    const rightPadding = (
      equityChart &&
      Number.isFinite(equityChart.width) &&
      equityChart.chartArea &&
      Number.isFinite(equityChart.chartArea.right)
    ) ? Math.max(0, Math.round(equityChart.width - equityChart.chartArea.right)) : 0;
    const ctx = canvas.getContext('2d');

    new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '每週損益',
            data: pnls,
            borderColor: borderColors,
            backgroundColor: barColors,
            borderWidth: 1,
            barPercentage: 0.7,
            categoryPercentage: 0.9
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: { right: rightPadding }
        },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            callbacks: {
              title(items) {
                const idx = items[0].dataIndex;
                const date = source.dates[idx];
                return date ? fmtDate(date) : '';
              },
              label(ctx) {
                return `每週損益: ${Math.round(ctx.parsed.y || 0).toLocaleString('zh-TW')}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'category',
            display: true,
            offset: true,
            grid: { offset: true },
            title: { display: true, text: '週期' },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              stepSize: 1,
              callback(_value, index) {
                return tickMap[index] || '';
              }
            }
          },
          y: {
            display: true,
            title: { display: true, text: '每週損益（金額）' },
            grid: { zeroLineWidth: 1 },
            afterFit(scale) {
              scale.width = 78;
            }
          }
        }
      }
    });

    return true;
  }

  function scheduleWeeklySync(range) {
    const runner = () => {
      try {
        window.__mq0807Debug = window.__mq0807Debug || {};
        window.__mq0807Debug.lastRange = range ? {
          start: range.start ? range.start.toISOString() : null,
          end: range.end ? range.end.toISOString() : null,
          label: range.label || null
        } : null;
        const displayedAxis = typeof window.__singleTrades_getDisplayedAxisSource === 'function'
          ? window.__singleTrades_getDisplayedAxisSource()
          : null;
        if (
          displayedAxis &&
          Array.isArray(displayedAxis.dates) &&
          displayedAxis.dates.length === 0
        ) {
          window.__mq0807Debug.lastSingleTradesSync = 'empty-axis';
          const cleared = syncWeeklyChartToCurrentRange(range);
          window.__mq0807Debug.lastFallbackSync = cleared;
          return cleared;
        }
        if (typeof window.__singleTrades_syncWeeklyToDisplayed === 'function') {
          const synced = window.__singleTrades_syncWeeklyToDisplayed();
          window.__mq0807Debug.lastSingleTradesSync = synced;
          if (synced) return true;
        }
        const fallback = syncWeeklyChartToCurrentRange(range);
        window.__mq0807Debug.lastFallbackSync = fallback;
        return fallback;
      } catch (err) {
        console.error('0807 weekly sync error', err);
        window.__mq0807Debug = window.__mq0807Debug || {};
        window.__mq0807Debug.lastError = String(err && err.message ? err.message : err);
        return false;
      }
    };

    [0, 80, 220].forEach((delay) => {
      window.setTimeout(runner, delay);
    });

    return true;
  }

  function renderPerformanceSummary() {
    resetPerformanceSummary();

    if (!summaryState.canon) {
      updatePeriodNote('等待資料載入後，即可切換圖表區間。');
      return;
    }

    try {
      const rows = parseCanon(summaryState.canon);
      if (!rows.length) {
        updatePeriodNote('目前沒有可計算的交易資料。');
        return;
      }

      const coverageStart8 = summaryState.start8 || rows[0].ts.slice(0, 8);
      const coverageStartDate = d8ToDate(coverageStart8);
      const coverageEndDate = getAnchorWeekEnd();
      const capitalBase = getCurrentCapital();
      const slipPerSide = getCurrentSlip();
      const dayMap = dailySeriesFromMerged(summaryState.canon, slipPerSide);
      const covered = makeCoveredSeries(dayMap, coverageStartDate, coverageEndDate);
      const prefix = buildPrefix(covered.vals);

      const renderDefs = (defs, calculator) => {
        defs.forEach(([key, offset]) => {
          const result = calculator(covered.days, prefix, coverageStartDate, coverageEndDate, offset, capitalBase);
          if (result.ret == null) {
            setPerfVisible(key, false);
            return;
          }
          setPerfVisible(key, true);
          setPerfRange(key, result.range);
          setPerfValue(key, result.ret);
        });
      };

      renderDefs(WEEK_DEFS, weekReturnUser);
      renderDefs(MONTH_DEFS, monthReturnUser);
      renderDefs(YEAR_DEFS, yearReturnUser);

      updatePeriodNote(`依目前本金 ${Math.round(capitalBase).toLocaleString('zh-TW')} 與滑價 ${slipPerSide} 點即時計算，期間截至 ${fmtDate(coverageEndDate)}。`);
    } catch (err) {
      console.error('renderPerformanceSummary error', err);
      resetPerformanceSummary();
      updatePeriodNote('區間績效暫時無法顯示，請稍後再試。');
    }
  }

  function bindSummaryEvents() {
    if (summaryEventsBound) return;
    summaryEventsBound = true;

    if (capitalInputEl) capitalInputEl.addEventListener('change', renderPerformanceSummary);
    if (slipInputEl) slipInputEl.addEventListener('change', renderPerformanceSummary);
    if (summaryRunBtn) {
      summaryRunBtn.addEventListener('click', function () {
        setTimeout(renderPerformanceSummary, 0);
      });
    }
  }

  function bindChartRangeEvents() {
    if (rangeEventsBound) return;
    rangeEventsBound = true;

    groupTabEls.forEach((button) => {
      button.addEventListener('click', () => {
        setActiveChartRangeGroup(button.dataset.rangeGroup);
      });
    });

    if (perfResetBtn) {
      perfResetBtn.addEventListener('click', () => applyChartRange('all'));
    }

    if (capitalInputEl) capitalInputEl.addEventListener('change', () => scheduleChartRangeRefresh(120));
    if (slipInputEl) slipInputEl.addEventListener('change', () => scheduleChartRangeRefresh(120));
    if (summaryRunBtn) summaryRunBtn.addEventListener('click', () => scheduleChartRangeRefresh(220));
  }

  async function feedToSingleTrades(filename, mergedText) {
    const fileInput = $('#fileInput');
    const runBtn    = $('#runBtn');

    // 確保第一次自動計算就用滑點=2
    const slipInput = $('#slipInput');
    if (slipInput) {
      slipInput.value = '2';
      slipInput.dispatchEvent(new Event('input',  { bubbles: true }));
      slipInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const fname = filename || `${STRATEGY_LABEL}.txt`;
    const file  = new File([mergedText], fname, { type: 'text/plain' });

    if (window.__singleTrades_setFile) {
      window.__singleTrades_setFile(file);
    }

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (runBtn) {
      setTimeout(() => runBtn.click(), 0);
    }
  }

  // ===== 主流程 =====
  async function boot() {
    try {
      bindSummaryEvents();
      bindChartRangeEvents();
      resetPerformanceSummary();
      renderChartRangeTabs();
      renderChartRangeChips();
      updatePeriodNote('等待資料載入後，這裡會顯示和首頁同一套期間績效。');

      const url       = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list   = [];

      // 1) 決定最新檔
      if (paramFile) {
        latest = {
          name    : paramFile.split('/').pop() || `${STRATEGY_LABEL}.txt`,
          fullPath: paramFile,
          from    : 'url'
        };
      } else {
        setStatus('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f =>
          WANT.test(f.name) || WANT.test(f.fullPath)
        );

        if (!list.length) {
          setStatus(`找不到檔名含「${STRATEGY_LABEL}」的 TXT（可用 ?file= 指定）。`, true);
          return;
        }

        // 排序：檔名最大日期 > updatedAt > size
        list.sort((a, b) => {
          const sa = lastDateScore(a.name);
          const sb = lastDateScore(b.name);
          if (sa !== sb) return sb - sa;
          if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
          return (b.size || 0) - (a.size || 0);
        });

        latest = list[0];
      }

      if (!latest) {
        setStatus(`找不到可分析的 ${STRATEGY_LABEL} 檔案。`, true);
        return;
      }
      if (elLatest) elLatest.textContent = latest.name;

      // 2) 基準檔：固定用「次新檔」（不讀 manifest，完全不發出 manifests 的 GET）
      let base = null;
      if (!paramFile) {
        base = list[1] || null;
      }

      if (elBase) elBase.textContent = base ? base.name : '（尚無）';

      // 3) 下載最新檔 & 基準檔，做 canonical 化與合併
      setStatus(`下載最新 ${STRATEGY_LABEL} 檔案並解碼中…`);

      const latestUrl = latest.from === 'url'
        ? latest.fullPath
        : pubUrl(latest.fullPath);

      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;
      let start8 = '';
      let end8   = '';

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url'
          ? base.fullPath
          : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);

        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedText = m.combined;
        start8     = m.start8;
        end8       = m.end8;
      } else {
        const rows = parseCanon(rNew.canon);
        start8 = rows.length ? rows[0].ts.slice(0, 8) : '';
        end8   = rows.length ? rows[rows.length - 1].ts.slice(0, 8) : '';
      }

      // 4) 配對清洗（避免後段位移）
      const cleaned = sanitizeCanonPaired(mergedText);
      mergedText = cleaned.canon;
      start8 = cleaned.start8 || start8;
      end8   = cleaned.end8   || end8;

      summaryState.canon = mergedText;
      summaryState.start8 = start8;
      summaryState.end8 = end8;
      summaryState.chartSource = null;
      summaryState.chartSlip = null;
      renderPerformanceSummary();
      syncChartRangeState();

      if (elPeriod) {
        elPeriod.textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;
      }

      // 5) 「設此為基準」：此頁固定唯讀（不寫入，避免任何額外紅字）
      if (btnBase) {
        btnBase.disabled = true;
        btnBase.textContent = '唯讀模式';
        btnBase.title = '此頁不寫入基準（不使用 manifest），基準固定為次新檔。';
        btnBase.onclick = null;
      }

      // 6) 加一行 header + canonical 3 欄餵給 single-trades.js
      const finalText = `${STRATEGY_LABEL} MERGED\n` + mergedText;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      scheduleChartRangeRefresh(280);
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
