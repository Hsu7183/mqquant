// multi-pro.js
// 三劍客量化科技機構級多檔分析（期貨版 - 多檔排名 + 頂檔資產曲線）
// 最終版：
// 1. 自動判斷 UTF-8 / Big5
// 2. 嚴格依 action 語義配對（新買/新賣/平賣/平買/強制平倉）
// 3. 與 single-trades.js 使用相同的核心解析邏輯
// 4. 避免空單被誤翻成多單
// 5. 頂檔圖表顯示分數最高那一檔的含滑價累積損益

(function () {
  'use strict';

  if (window.__mq0807Security && window.__mq0807Security.blocked) {
    return;
  }

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);

  const capitalInput = $('#capitalInput');
  const slipInput    = $('#slipInput');
  const fileInput    = $('#fileInput');
  const runBtn       = $('#runBtn');
  const statusLine   = $('#statusLine');
  const table        = $('#resultTable');
  const tbody        = table.querySelector('tbody');
  const scoreChartEl = $('#scoreChart');
  const chartTitleEl = $('#chartTitle');

  // ===== 全域狀態 =====
  const CFG = {
    pointValue: 200,
    feePerSide: 45,
    taxRate: 0.00002,
    slipPerSide: 0,
    capital: 1000000
  };

  let gResults = [];
  let gSort = { key: 'score', dir: 'desc' };
  let gChart = null;

  // ===== 小工具 =====
  const fmtInt = (n) => {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  };

  const fmtPct = (p) => {
    if (p == null || !isFinite(p)) return '—';
    return (p * 100).toFixed(2) + '%';
  };

  const fmtFloat = (x, d) => {
    if (x == null || !isFinite(x)) return '—';
    return x.toFixed(d);
  };

  function makeCompactTag(name) {
    const m = name.match(/(\d{8})_(\d{6})/);
    if (!m) return name;
    const day = m[1].slice(6, 8);
    return `${day}_${m[2]}`;
  }

  function headerToValues(header) {
    if (!header) return '';
    return header.split(',').map(seg => {
      const idx = seg.indexOf('=');
      return idx >= 0 ? seg.slice(idx + 1) : seg;
    }).join(',');
  }

  // ===== 時間工具 =====
  function tsToDate(ts) {
    if (!ts) return null;
    const clean = ts.replace(/\D/g, '');
    if (clean.length < 8) return null;
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10) - 1;
    const d = parseInt(clean.slice(6, 8), 10);
    const hh = clean.length >= 10 ? parseInt(clean.slice(8, 10), 10) : 0;
    const mm = clean.length >= 12 ? parseInt(clean.slice(10, 12), 10) : 0;
    return new Date(y, m, d, hh, mm, 0);
  }

  function fmtAxisLabel(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  function tsDayKey(ts) {
    if (!ts) return '';
    const clean = ts.replace(/\D/g, '');
    return clean.slice(0, 8);
  }

  function dateWeekKey(d) {
    if (!d) return '';
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return tmp.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : weekNo);
  }

  // ===== action 工具 =====
  function normAction(s) {
    return (s || '').trim();
  }

  function dirFromAction(action) {
    const a = normAction(action);
    if (a === '新買') return 1;
    if (a === '新賣') return -1;
    return null;
  }

  function isEntryAction(action) {
    const a = normAction(action);
    return a === '新買' || a === '新賣';
  }

  function isExitAction(action) {
    const a = normAction(action);
    return a === '平賣' || a === '平買' || a === '強制平倉';
  }

  function exitDirFromAction(action, openDir) {
    const a = normAction(action);
    if (a === '平賣') return 1;
    if (a === '平買') return -1;
    if (a === '強制平倉') return openDir;
    return openDir;
  }

  function getDirFromInpos(lines, startIdx) {
    const maxLookAhead = 300;
    const total = lines.length;

    for (let j = startIdx + 1; j < total && j <= startIdx + maxLookAhead; j++) {
      const line = lines[j];
      const ps = line.split(/\s+/);
      if (!ps.length) continue;

      if (ps.length >= 6 && ps[ps.length - 1] === 'INPOS') {
        const dir = parseInt(ps[3], 10);
        if (dir === 1 || dir === -1) return dir;
      }

      if (ps.length === 3 && ps[ps.length - 1] !== 'INPOS') {
        break;
      }
    }
    return 1;
  }

  // ===== 智慧讀檔：UTF-8 / Big5 =====
  async function readFileTextSmart(file) {
    const ab = await file.arrayBuffer();

    let textUtf8 = '';
    try {
      textUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(ab);
    } catch (e) {
      textUtf8 = '';
    }

    if (
      textUtf8.includes('新買') ||
      textUtf8.includes('新賣') ||
      textUtf8.includes('平買') ||
      textUtf8.includes('平賣') ||
      textUtf8.includes('強制平倉')
    ) {
      return textUtf8;
    }

    try {
      const textBig5 = new TextDecoder('big5', { fatal: false }).decode(ab);
      if (
        textBig5.includes('新買') ||
        textBig5.includes('新賣') ||
        textBig5.includes('平買') ||
        textBig5.includes('平賣') ||
        textBig5.includes('強制平倉')
      ) {
        return textBig5;
      }
    } catch (e) {
      // ignore
    }

    return textUtf8;
  }

  // ===== 解析 TXT：與 single-trades.js 同步 =====
  function parseTxt(text) {
    const allLines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!allLines.length) return { header: null, trades: [] };

    const header = allLines[0];
    const lines  = allLines.slice(1);

    const trades = [];
    let open = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ps   = line.split(/\s+/);
      if (ps.length < 2) continue;

      const ts = ps[0];
      const px = parseFloat(ps[1]);
      if (!isFinite(px)) continue;

      if (ps[ps.length - 1] === 'INPOS') continue;
      if (ps.length !== 3) continue;

      const action  = normAction(ps[2]);
      const isEntry = isEntryAction(action);
      const isExit  = isExitAction(action);

      if (!isEntry && !isExit) continue;

      if (!open) {
        if (!isEntry) continue;

        let dir = dirFromAction(action);
        if (dir == null) dir = getDirFromInpos(lines, i);
        if (dir !== 1 && dir !== -1) continue;

        open = { ts, px, dir, action };
        continue;
      }

      if (!isExit) {
        let dir = dirFromAction(action);
        if (dir == null) dir = getDirFromInpos(lines, i);
        if (dir !== 1 && dir !== -1) {
          open = null;
          continue;
        }
        open = { ts, px, dir, action };
        continue;
      }

      const openDir    = open.dir;
      const entryPx    = open.px;
      const exitPx     = px;
      const exitAction = action;

      if (
        exitAction !== '強制平倉' &&
        !((openDir > 0 && exitAction === '平賣') ||
          (openDir < 0 && exitAction === '平買'))
      ) {
        continue;
      }

      const dirForPnl = exitDirFromAction(exitAction, openDir);

      const points = dirForPnl > 0
        ? (exitPx - entryPx)
        : (entryPx - exitPx);

      const gross = points * CFG.pointValue;
      const fee   = CFG.feePerSide * 2;
      const taxIn = Math.round(entryPx * CFG.pointValue * CFG.taxRate);
      const taxOut= Math.round(exitPx  * CFG.pointValue * CFG.taxRate);
      const tax   = taxIn + taxOut;
      const theoNet = gross - fee - tax;

      trades.push({
        entry: { ts: open.ts, px: open.px, action: open.action },
        exit:  { ts, px: exitPx, action: exitAction },
        dir: openDir,
        points,
        fee,
        tax,
        theoNet
      });

      open = null;
    }

    return { header, trades };
  }

  // ===== KPI 計算 =====
  function calcKpi(trades, pnls, equity) {
    const n = pnls.length;
    if (!n) return null;

    let sum = 0;
    let sumSq = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let largestWin = null;
    let largestLoss = null;

    pnls.forEach(p => {
      sum += p;
      sumSq += p * p;
      if (p > 0) {
        grossProfit += p;
        wins++;
        if (largestWin === null || p > largestWin) largestWin = p;
      } else if (p < 0) {
        grossLoss += p;
        losses++;
        if (largestLoss === null || p < largestLoss) largestLoss = p;
      }
    });

    const totalNet = sum;
    const avg      = sum / n;
    const winRate  = wins / n;
    const avgWin   = wins   ? grossProfit / wins   : 0;
    const avgLoss  = losses ? grossLoss  / losses  : 0;
    const payoff   = (avgLoss < 0) ? (avgWin / Math.abs(avgLoss)) : null;
    const pf       = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;

    const mean   = avg;
    const varT   = n > 1 ? (sumSq / n - mean * mean) : 0;
    const stdev  = varT > 0 ? Math.sqrt(varT) : 0;

    const sharpeTrade  = stdev > 0 ? (mean / stdev) * Math.sqrt(n) : null;

    let downsideSq = 0;
    let downsideCnt = 0;
    pnls.forEach(p => {
      if (p < 0) {
        downsideSq += p * p;
        downsideCnt++;
      }
    });
    const downsideDev   = downsideCnt > 0 ? Math.sqrt(downsideSq / downsideCnt) : 0;
    const sortinoTrade  = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(n) : null;

    let peak = 0;
    let maxDd = 0;
    let maxDdStartIdx = 0;
    let maxDdEndIdx   = 0;
    let curPeakIdx    = 0;
    for (let i = 0; i < equity.length; i++) {
      const v = equity[i];
      if (v > peak) {
        peak = v;
        curPeakIdx = i;
      }
      const dd = peak - v;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdStartIdx = curPeakIdx;
        maxDdEndIdx   = i;
      }
    }

    const totalReturnPct = CFG.capital > 0 ? totalNet / CFG.capital : null;
    const maxDdPct       = CFG.capital > 0 ? maxDd   / CFG.capital : null;

    const exitDates = trades.map(t => tsToDate(t.exit.ts));
    let cagr = null;
    if (exitDates.length) {
      const first = exitDates[0];
      const last  = exitDates[exitDates.length - 1];
      if (first && last && last > first && CFG.capital > 0) {
        const days  = (last - first) / 86400000;
        const years = days / 365;
        if (years > 0) {
          const finalNav = CFG.capital + totalNet;
          const ratio    = finalNav / CFG.capital;
          cagr = Math.pow(ratio, 1 / years) - 1;
        }
      }
    }

    const calmar = (maxDdPct != null && maxDdPct > 0 && cagr != null)
      ? (cagr / maxDdPct)
      : null;

    const timeToRecoveryTrades =
      maxDdEndIdx > maxDdStartIdx ? (maxDdEndIdx - maxDdStartIdx) : 0;

    const nav = equity.map(v => CFG.capital + v);
    let peakNav = 0;
    let sumDdSq = 0;
    for (let i = 0; i < nav.length; i++) {
      const v = nav[i];
      if (v > peakNav) peakNav = v;
      const ddPct = peakNav > 0 ? (peakNav - v) / peakNav : 0;
      sumDdSq += ddPct * ddPct;
    }
    const ulcerIndex    = nav.length ? Math.sqrt(sumDdSq / nav.length) : null;
    const recoveryFactor= maxDd > 0 ? totalNet / maxDd : null;

    const dayMap = {};
    const weekMap = {};
    pnls.forEach((p, i) => {
      const t  = trades[i];
      const dk = tsDayKey(t.exit.ts);
      if (dk) dayMap[dk] = (dayMap[dk] || 0) + p;
      const d = exitDates[i];
      if (d) {
        const wk = dateWeekKey(d);
        weekMap[wk] = (weekMap[wk] || 0) + p;
      }
    });

    const worstDayPnl  = Object.values(dayMap).reduce((m, v) => (v < m ? v : m), 0);
    const worstWeekPnl = Object.values(weekMap).reduce((m, v) => (v < m ? v : m), 0);

    const sortedPnls = pnls.slice().sort((a, b) => a - b);
    const alpha = 0.95;
    const idx   = Math.floor((1 - alpha) * sortedPnls.length);
    const varLoss = sortedPnls.length
      ? -sortedPnls[Math.min(idx, sortedPnls.length - 1)]
      : null;

    let tailSum = 0;
    let tailCnt = 0;
    for (let i = 0; i <= idx && i < sortedPnls.length; i++) {
      tailSum += sortedPnls[i];
      tailCnt++;
    }
    const cvarLoss = tailCnt > 0 ? -(tailSum / tailCnt) : null;

    const expectancy = avg;
    let kelly = null;
    if (payoff != null && payoff > 0 && winRate > 0 && winRate < 1) {
      const p = winRate;
      const q = 1 - winRate;
      kelly = p - q / payoff;
    }

    let riskOfRuin = null;
    if (varT <= 0) {
      riskOfRuin = null;
    } else if (avg <= 0) {
      riskOfRuin = 1;
    } else {
      const mu     = avg;
      const sigma2 = varT;
      const exponent = -2 * mu * CFG.capital / sigma2;
      const r = Math.exp(exponent);
      riskOfRuin = Math.min(1, Math.max(0, r));
    }

    let totalFee  = 0;
    let totalTax  = 0;
    let notionalTraded = 0;
    const slipPerTradeMoney = CFG.pointValue * CFG.slipPerSide * 2;

    trades.forEach(t => {
      totalFee  += t.fee;
      totalTax  += t.tax;
      notionalTraded += t.entry.px * CFG.pointValue;
    });

    const totalSlipCost = slipPerTradeMoney * trades.length;
    const totalCost     = totalFee + totalTax + totalSlipCost;
    const totalGrossAbs = grossProfit + Math.abs(grossLoss);
    const turnover      = CFG.capital > 0 ? (notionalTraded / CFG.capital) : null;
    const costRatio     = totalGrossAbs > 0 ? (totalCost / totalGrossAbs) : null;

    const tradingDays = Object.keys(dayMap).length;
    const tradesPerDay= tradingDays > 0 ? n / tradingDays : null;

    let totalHoldMin = 0;
    trades.forEach(t => {
      const dIn  = tsToDate(t.entry.ts);
      const dOut = tsToDate(t.exit.ts);
      if (dIn && dOut && dOut >= dIn) {
        totalHoldMin += (dOut - dIn) / 60000;
      }
    });
    const avgHoldMin = n > 0 ? totalHoldMin / n : null;

    let stabilityR2 = null;
    if (nav.length >= 3) {
      const xs = nav.map((_, i) => i + 1);
      const ys = nav;
      const N  = xs.length;
      const sumX  = xs.reduce((a, v) => a + v, 0);
      const sumY  = ys.reduce((a, v) => a + v, 0);
      const sumXY = xs.reduce((a, v, i) => a + v * ys[i], 0);
      const sumX2 = xs.reduce((a, v) => a + v * v, 0);
      const meanY = sumY / N;
      const ssTot = ys.reduce((a, v) => a + (v - meanY) * (v - meanY), 0);
      const slope = (N * sumXY - sumX * sumY) / (N * sumX2 - sumX * sumX);
      const intercept = meanY - slope * (sumX / N);
      let ssRes = 0;
      for (let i = 0; i < N; i++) {
        const yhat = slope * xs[i] + intercept;
        ssRes += (ys[i] - yhat) * (ys[i] - yhat);
      }
      stabilityR2 = ssTot > 0 ? 1 - (ssRes / ssTot) : null;
    }

    return {
      totalNet,
      totalReturnPct,
      cagr,
      maxDd,
      maxDdPct,
      ulcerIndex,
      recoveryFactor,
      timeToRecoveryTrades,
      worstDayPnl,
      worstWeekPnl,
      varLoss,
      cvarLoss,
      riskOfRuin,
      volPerTrade: stdev,
      sharpeTrade,
      sortinoTrade,
      calmar,
      nTrades: n,
      winRate,
      avg,
      avgWin,
      avgLoss,
      payoff,
      expectancy,
      pf,
      grossProfit,
      grossLoss,
      largestWin,
      largestLoss,
      kelly,
      stabilityR2,
      tradingDays,
      tradesPerDay,
      avgHoldMin,
      turnover,
      totalFee,
      totalTax,
      totalSlipCost,
      totalCost,
      costRatio
    };
  }

  // ===== KPI 評級 =====
  function rateMetric(key, value) {
    if (value == null || !isFinite(value)) return null;

    let label = 'Adequate';
    let css   = 'rating-adequate';

    switch (key) {
      case 'maxdd_pct':
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.30)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'total_return':
      case 'cagr':
        if (value >= 0.15)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.05)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'pf':
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1.1)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'winrate':
        if (value >= 0.55)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.45)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'sharpe':
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.8)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'sortino':
        if (value >= 2)          { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1)     { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'calmar':
        if (value >= 0.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.2)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'risk_ruin':
        if (value <= 0.05)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.20)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'cost_ratio':
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.40)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      default:
        return null;
    }
    return { label, cssClass: css };
  }

  function computeScore(k) {
    if (!k) return null;
    const metrics = [
      { key: 'maxdd_pct',    v: k.maxDdPct },
      { key: 'total_return', v: k.totalReturnPct },
      { key: 'cagr',         v: k.cagr },
      { key: 'pf',           v: k.pf },
      { key: 'winrate',      v: k.winRate },
      { key: 'sharpe',       v: k.sharpeTrade },
      { key: 'sortino',      v: k.sortinoTrade },
      { key: 'calmar',       v: k.calmar },
      { key: 'risk_ruin',    v: k.riskOfRuin },
      { key: 'cost_ratio',   v: k.costRatio }
    ];

    let sum = 0;
    let cnt = 0;

    metrics.forEach(m => {
      const r = rateMetric(m.key, m.v);
      if (!r) return;
      let pts = 0;
      if (r.label === 'Strong') pts = 90;
      else if (r.label === 'Adequate') pts = 75;
      else pts = 60;
      sum += pts;
      cnt++;
    });

    if (!cnt) return null;
    return sum / cnt;
  }

  function scoreBadgeClass(score) {
    if (score == null || !isFinite(score)) return 'score-badge score-improve';
    if (score >= 85) return 'score-badge score-strong';
    if (score >= 70) return 'score-badge score-adequate';
    return 'score-badge score-improve';
  }

  // ===== 主流程 =====
  async function runAnalysis() {
    const files = Array.prototype.slice.call(fileInput.files || []);
    if (!files.length) {
      alert('請先選擇至少一個 TXT 檔案');
      return;
    }

    CFG.capital     = Number(capitalInput.value) || 1000000;
    CFG.slipPerSide = Number(slipInput.value) || 0;

    runBtn.disabled = true;
    fileInput.disabled = true;
    statusLine.textContent = `讀取與計算中……（共 ${files.length} 檔）`;

    gResults = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        // eslint-disable-next-line no-await-in-loop
        const text = await readFileTextSmart(f);
        const parsed = parseTxt(text);
        const trades = parsed.trades;

        if (!trades.length) {
          console.warn('[multi-pro] no trades parsed:', f.name);
          continue;
        }

        let cumTheo = 0;
        let cumAct  = 0;
        const theoPnls   = [];
        const theoEquity = [];
        const actPnls    = [];
        const actEquity  = [];
        const slipCostPerTrade = CFG.pointValue * CFG.slipPerSide * 2;

        const eqDates = [];
        const eqValues = [];
        let cumForEq = 0;

        trades.forEach((t, idx) => {
          cumTheo += t.theoNet;
          const actualNet = t.theoNet - slipCostPerTrade;
          cumAct  += actualNet;

          theoPnls.push(t.theoNet);
          theoEquity.push(cumTheo);

          actPnls.push(actualNet);
          actEquity.push(cumAct);

          cumForEq += actualNet;
          const exitDate = tsToDate(t.exit.ts);
          if (exitDate) {
            eqDates.push(exitDate);
            eqValues.push(cumForEq);
          }
        });

        const kpiTheo = calcKpi(trades, theoPnls, theoEquity);
        const kpiAct  = calcKpi(trades, actPnls, actEquity);
        const score   = computeScore(kpiAct);

        gResults.push({
          fileName: f.name,
          dateTag:  makeCompactTag(f.name),
          params:   headerToValues(parsed.header),
          score,
          kpi: kpiAct,
          kpiTheo,
          equityTimeline: { dates: eqDates, values: eqValues }
        });

        statusLine.textContent = `計算中…… ${i + 1} / ${files.length}`;
      } catch (e) {
        console.error('[multi-pro] 讀取檔案錯誤：', f.name, e);
      }
    }

    gSort = { key: 'score', dir: 'desc' };
    sortAndRender();

    statusLine.textContent = `完成：共計算 ${gResults.length} 檔。`;
    runBtn.disabled = false;
    fileInput.disabled = false;
  }

  // ===== 表格 =====
  function renderTable() {
    tbody.innerHTML = '';

    gResults.forEach(r => {
      const k = r.kpi || {};
      const tr = document.createElement('tr');

      const tdDate = document.createElement('td');
      tdDate.textContent = r.dateTag;
      tr.appendChild(tdDate);

      const tdParam = document.createElement('td');
      tdParam.textContent = r.params;
      tr.appendChild(tdParam);

      const tdScore = document.createElement('td');
      const span = document.createElement('span');
      span.textContent = r.score != null && isFinite(r.score) ? r.score.toFixed(1) : '—';
      span.className = scoreBadgeClass(r.score);
      tdScore.appendChild(span);
      tr.appendChild(tdScore);

      function kpiCell(value, fmt, ratingKey) {
        const td = document.createElement('td');
        let txt = '—';
        if (fmt === 'pct') txt = fmtPct(value);
        else if (fmt === 'int') txt = fmtInt(value);
        else if (fmt === 'f2') txt = fmtFloat(value, 2);
        else if (fmt === 'f3') txt = fmtFloat(value, 3);

        td.textContent = txt;

        if (ratingKey) {
          const rating = rateMetric(ratingKey, value);
          if (rating) td.classList.add(rating.cssClass);
        }
        return td;
      }

      tr.appendChild(kpiCell(k.cagr,           'pct', 'cagr'));
      tr.appendChild(kpiCell(k.totalReturnPct, 'pct', 'total_return'));
      tr.appendChild(kpiCell(k.maxDdPct,       'pct', 'maxdd_pct'));
      tr.appendChild(kpiCell(k.pf,             'f2',  'pf'));
      tr.appendChild(kpiCell(k.winRate,        'pct', 'winrate'));
      tr.appendChild(kpiCell(k.sharpeTrade,    'f2',  'sharpe'));
      tr.appendChild(kpiCell(k.sortinoTrade,   'f2',  'sortino'));
      tr.appendChild(kpiCell(k.calmar,         'f2',  'calmar'));
      tr.appendChild(kpiCell(k.riskOfRuin,     'pct', 'risk_ruin'));
      tr.appendChild(kpiCell(k.costRatio,      'pct', 'cost_ratio'));

      tr.appendChild(kpiCell(k.nTrades,        'int'));
      tr.appendChild(kpiCell(k.avg,            'int'));
      tr.appendChild(kpiCell(k.worstDayPnl,    'int'));
      tr.appendChild(kpiCell(k.worstWeekPnl,   'int'));
      tr.appendChild(kpiCell(k.ulcerIndex,     'f3'));
      tr.appendChild(kpiCell(k.recoveryFactor, 'f2'));
      tr.appendChild(kpiCell(k.turnover,       'f2'));

      tbody.appendChild(tr);
    });

    const ths = table.querySelectorAll('th.sortable');
    ths.forEach(th => {
      th.removeAttribute('data-sort-dir');
      const key = th.dataset.key;
      if (key === gSort.key) {
        th.setAttribute('data-sort-dir', gSort.dir);
      }
    });
  }

  // ===== 圖表 =====
  function renderChart() {
    if (!scoreChartEl || !window.Chart) return;

    if (gChart) {
      gChart.destroy();
      gChart = null;
    }

    if (!gResults.length) {
      chartTitleEl.textContent = '頂檔資產曲線（含滑價累積損益）';
      return;
    }

    const top = gResults[0];
    const timeline = top.equityTimeline || { dates: [], values: [] };
    const labels = (timeline.dates || []).map(fmtAxisLabel);
    const data   = timeline.values || [];

    const ctx = scoreChartEl.getContext('2d');

    chartTitleEl.textContent =
      `頂檔資產曲線（含滑價累積損益）｜${top.fileName}`;

    gChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '含滑價累積損益',
          data,
          borderWidth: 2,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `累積損益：${fmtInt(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: '交易序號' }
          },
          y: {
            title: { display: true, text: '累積損益（含滑價）' }
          }
        }
      }
    });
  }

  // ===== 排序 =====
  function sortAndRender() {
    const key = gSort.key;
    const dir = gSort.dir === 'asc' ? 1 : -1;

    gResults.sort((a, b) => {
      let va, vb;

      if (key === 'dateTag') {
        va = a.dateTag;
        vb = b.dateTag;
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      }

      if (key === 'score') {
        va = a.score || 0;
        vb = b.score || 0;
      } else {
        const kA = a.kpi || {};
        const kB = b.kpi || {};
        switch (key) {
          case 'cagr':           va = kA.cagr;           vb = kB.cagr; break;
          case 'totalReturn':    va = kA.totalReturnPct; vb = kB.totalReturnPct; break;
          case 'maxDdPct':       va = kA.maxDdPct;       vb = kB.maxDdPct; break;
          case 'pf':             va = kA.pf;             vb = kB.pf; break;
          case 'winRate':        va = kA.winRate;        vb = kB.winRate; break;
          case 'sharpe':         va = kA.sharpeTrade;    vb = kB.sharpeTrade; break;
          case 'sortino':        va = kA.sortinoTrade;   vb = kB.sortinoTrade; break;
          case 'calmar':         va = kA.calmar;         vb = kB.calmar; break;
          case 'riskOfRuin':     va = kA.riskOfRuin;     vb = kB.riskOfRuin; break;
          case 'costRatio':      va = kA.costRatio;      vb = kB.costRatio; break;
          case 'nTrades':        va = kA.nTrades;        vb = kB.nTrades; break;
          case 'avgTrade':       va = kA.avg;            vb = kB.avg; break;
          case 'worstDay':       va = kA.worstDayPnl;    vb = kB.worstDayPnl; break;
          case 'worstWeek':      va = kA.worstWeekPnl;   vb = kB.worstWeekPnl; break;
          case 'ulcer':          va = kA.ulcerIndex;     vb = kB.ulcerIndex; break;
          case 'recoveryFactor': va = kA.recoveryFactor; vb = kB.recoveryFactor; break;
          case 'turnover':       va = kA.turnover;       vb = kB.turnover; break;
          default: va = 0; vb = 0;
        }
      }

      if (!isFinite(va) && !isFinite(vb)) return 0;
      if (!isFinite(va)) return 1;
      if (!isFinite(vb)) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });

    renderTable();
    renderChart();
  }

  // ===== 事件 =====
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      runBtn.disabled = false;
      statusLine.textContent = `已選擇 ${fileInput.files.length} 檔 TXT，可按「計算」。`;
    } else {
      runBtn.disabled = true;
      statusLine.textContent = '說明：一次可選擇多個期貨 TXT（含 INPOS），將依單檔分析的 KPI 與分數邏輯計算。';
    }
  });

  capitalInput.addEventListener('change', () => {
    CFG.capital = Number(capitalInput.value) || 1000000;
  });

  slipInput.addEventListener('change', () => {
    CFG.slipPerSide = Number(slipInput.value) || 0;
  });

  runBtn.addEventListener('click', () => {
    runAnalysis();
  });

  const ths = table.querySelectorAll('th.sortable');
  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (!key) return;
      if (gSort.key === key) {
        gSort.dir = gSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        gSort.key = key;
        gSort.dir = key === 'dateTag' ? 'asc' : 'desc';
      }
      sortAndRender();
    });
  });

})();
