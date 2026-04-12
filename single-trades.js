// single-trades.js
// MQ Quant 機構級單檔分析：KPI + 每週資產曲線 + 交易明細
// 最終版：
// 1. 嚴格依 action 語義配對（新買/新賣/平賣/平買/強制平倉）
// 2. 避免新賣被誤翻成新買
// 3. 自動判斷 UTF-8 / Big5 編碼
// 4. 本機選檔可自動計算
// 5. 雲端檔可由 single-trades-cloud.js 呼叫自動計算
// 6. 雲端失敗不影響本機分析

(function () {
  'use strict';

  if (window.__mq0807Security && window.__mq0807Security.blocked) {
    return;
  }

  const CFG = {
    pointValue: 200,
    feePerSide: 45,
    taxRate: 0.00002,
    slipPerSide: 0,
    capital: 1000000
  };

  let gParsed = null;
  let gFile   = null;
  let gChart  = null;
  let gWeeklyChart = null;
  let gChartSource = null;
  let gEquityAxisSource = null;

  const $ = (s) => document.querySelector(s);

  const fmtInt = (n) => {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  };

  const fmtSignedInt = (n) => {
    if (n == null || !isFinite(n)) return '—';
    const v = Math.round(n);
    return v.toLocaleString('en-US');
  };

  const fmtPct = (p) => {
    if (p == null || !isFinite(p)) return '—';
    return (p * 100).toFixed(2) + '%';
  };

  const fmtFloat = (x, d) => {
    if (x == null || !isFinite(x)) return '—';
    return x.toFixed(d);
  };

  const clsForNumber = (n) => {
    if (n == null || !isFinite(n) || n === 0) return '';
    return n > 0 ? 'num-pos' : 'num-neg';
  };

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

  function formatTs(ts) {
    if (!ts) return '';
    const clean = ts.replace(/\D/g, '');
    if (clean.length < 12) return ts;
    const y  = clean.slice(0, 4);
    const m  = clean.slice(4, 6);
    const d  = clean.slice(6, 8);
    const hh = clean.slice(8, 10);
    const mm = clean.slice(10, 12);
    return `${y}/${parseInt(m, 10)}/${parseInt(d, 10)} ${hh}:${mm}`;
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

  function rateMetric(key, value) {
    if (value == null || !isFinite(value)) return null;

    let label = 'Adequate';
    let css   = 'rating-adequate';
    let ref   = '—';

    switch (key) {
      case 'maxdd_pct':
        ref = '≦ 20% 強；20–30% 可接受；>30% 需優化';
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.30)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'total_return':
      case 'cagr':
        ref = '≥ 15% 強；5–15% 可接受；<5% 需優化';
        if (value >= 0.15)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.05)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'pf':
        ref = '≥ 1.5 強；1.1–1.5 可接受；<1.1 需優化';
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1.1)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'winrate':
        ref = '≥ 55% 強；45–55% 可接受；<45% 需優化';
        if (value >= 0.55)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.45)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'sharpe':
        ref = '≥ 1.5 強；0.8–1.5 可接受；<0.8 需優化';
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.8)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'sortino':
        ref = '≥ 2 強；1–2 可接受；<1 需優化';
        if (value >= 2)          { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1)     { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'calmar':
        ref = '≥ 0.5 強；0.2–0.5 可接受；<0.2 需優化';
        if (value >= 0.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.2)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'risk_ruin':
        ref = '≦ 5% 強；5–20% 可接受；>20% 需優化';
        if (value <= 0.05)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.20)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'cost_ratio':
        ref = '≦ 20% 強；20–40% 可接受；>40% 需優化';
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.40)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      default:
        return null;
    }
    return { label, cssClass: css, ref };
  }

  function renderScore(score) {
    const card = document.getElementById('scoreCard');
    if (!card) return;

    if (score == null || !isFinite(score)) {
      card.innerHTML = `
        <div class="score-title">綜合分數</div>
        <div class="score-value">—</div>
        <div class="score-desc">載入檔案後自動計算</div>
      `;
      return;
    }

    const v = score.toFixed(1);
    let cls   = 'adequate';
    let label = 'Adequate';
    if (score >= 85) {
      cls   = 'strong';
      label = 'Strong';
    } else if (score < 70) {
      cls   = 'improve';
      label = 'Improve';
    }

    card.innerHTML = `
      <div class="score-title">綜合分數</div>
      <div class="score-value ${cls}">${v}</div>
      <div class="score-desc">${label}｜以核心 KPI 加權計算（含滑價）</div>
    `;
  }

  function calcKpi(trades, pnls, equity, slipPerSide) {
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

    const sharpeTrade = stdev > 0 ? (mean / stdev) * Math.sqrt(n) : null;

    let downsideSq = 0;
    let downsideCnt = 0;
    pnls.forEach(p => {
      if (p < 0) {
        downsideSq += p * p;
        downsideCnt++;
      }
    });
    const downsideDev  = downsideCnt > 0 ? Math.sqrt(downsideSq / downsideCnt) : 0;
    const sortinoTrade = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(n) : null;

    let peak = 0;
    let maxDd = 0;
    let maxDdStartIdx = 0;
    let maxDdEndIdx = 0;
    let curPeakIdx = 0;

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
    const maxDdPct       = CFG.capital > 0 ? maxDd / CFG.capital : null;

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
    const ulcerIndex     = nav.length ? Math.sqrt(sumDdSq / nav.length) : null;
    const recoveryFactor = maxDd > 0 ? totalNet / maxDd : null;

    const dayMap = {};
    const weekMap = {};
    pnls.forEach((p, i) => {
      const t = trades[i];
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
      const q = 1 - p;
      kelly = p - q / payoff;
    }

    let riskOfRuin = null;
    if (varT <= 0) {
      riskOfRuin = null;
    } else if (avg <= 0) {
      riskOfRuin = 1;
    } else {
      const mu = avg;
      const sigma2 = varT;
      const exponent = -2 * mu * CFG.capital / sigma2;
      const r = Math.exp(exponent);
      riskOfRuin = Math.min(1, Math.max(0, r));
    }

    let totalFee  = 0;
    let totalTax  = 0;
    let notionalTraded = 0;
    const slipPerTradeMoney = CFG.pointValue * slipPerSide * 2;
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

  function renderKpi(kpiTheo, kpiAct) {
    const tbody   = $('#kpiBody');
    const badBody = $('#kpiBadBody');
    if (!tbody || !badBody) return;

    tbody.innerHTML   = '';
    badBody.innerHTML = '';
    renderScore(null);

    if (!kpiAct) {
      badBody.innerHTML = '<tr><td colspan="5" style="color:#777;">尚未載入資料。</td></tr>';
      return;
    }

    const badList = [];
    let scoreSum   = 0;
    let scoreCount = 0;

    const toStr = (fmt, v) => {
      if (v == null || !isFinite(v)) return '—';
      if (fmt === 'pct') {
        if (v < 0) return '—';
        if (v < 0.0001) return '<0.01%';
        return fmtPct(v);
      }
      if (fmt === 'f1') return fmtFloat(v, 1);
      if (fmt === 'f2') return fmtFloat(v, 2);
      if (fmt === 'f3') return fmtFloat(v, 3);
      if (fmt === 'f4') return fmtFloat(v, 4);
      return fmtInt(v);
    };

    const addSection = (title) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="kpi-section" colspan="6">${title}</td>`;
      tbody.appendChild(tr);
    };

    const addRow = (key, name, fmt, vTheo, vAct, desc) => {
      const sTheo = toStr(fmt, vTheo);
      const sAct  = toStr(fmt, vAct);

      const rating = key ? rateMetric(key, vAct) : null;
      const ratingLabel = rating ? rating.label : '—';
      const ratingClass = rating ? rating.cssClass : '';
      const refRange    = rating ? rating.ref : '—';

      if (rating && rating.label && rating.label.startsWith('Improve')) {
        badList.push({
          name,
          valueStr: sAct,
          ratingLabel,
          ratingClass,
          refRange
        });
      }

      if (rating) {
        let pts = 0;
        if (rating.label === 'Strong') pts = 90;
        else if (rating.label === 'Adequate') pts = 75;
        else pts = 60;
        scoreSum += pts;
        scoreCount += 1;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="kpi-name">${name}</td>
        <td class="num">${sTheo}</td>
        <td class="num ${ratingClass}">${sAct}</td>
        <td class="kpi-desc">${desc}</td>
        <td class="center ${ratingClass}">${ratingLabel}</td>
        <td class="center">${refRange}</td>
      `;
      tbody.appendChild(tr);
    };

    const t = kpiTheo || {};
    const a = kpiAct;

    addSection('Tier 1．生存與尾端風險（Risk / Survival）');
    addRow('maxdd_pct', '最大回撤率 Max Drawdown %', 'pct', t.maxDdPct, a.maxDdPct, '以本金為基準的最大淨值跌幅');
    addRow(null, '最大回撤金額 Max Drawdown', 'int', t.maxDd, a.maxDd, '累積淨損益的最大下跌金額');
    addRow('risk_ruin', '破產風險 Risk of Ruin（近似）', 'pct', t.riskOfRuin, a.riskOfRuin, '以 Brownian 近似估算的長期觸及破產線機率');
    addRow(null, '最差單日損益 Worst Day PnL', 'int', t.worstDayPnl, a.worstDayPnl, '以出場日統計的單日最差實際損益');
    addRow(null, '最差單週損益 Worst Week PnL', 'int', t.worstWeekPnl, a.worstWeekPnl, '以出場週統計的單週最差實際損益');
    addRow(null, '95% VaR（單筆）', 'int', t.varLoss, a.varLoss, '單筆損益 95% Value-at-Risk');
    addRow(null, '95% CVaR（單筆）', 'int', t.cvarLoss, a.cvarLoss, '左尾區間平均損失');
    addRow(null, '回神時間 Time to Recovery（筆）', 'int', t.timeToRecoveryTrades, a.timeToRecoveryTrades, '最大回撤後重新創高所需交易筆數');
    addRow(null, 'Ulcer Index', 'f4', t.ulcerIndex, a.ulcerIndex, 'NAV 痛苦指標');
    addRow(null, 'Recovery Factor', 'f2', t.recoveryFactor, a.recoveryFactor, '總淨利 / 最大回撤');

    addSection('Tier 2．報酬與風險調整後報酬（Return / Risk-Adjusted）');
    addRow(null, '總淨利 Net Profit', 'int', t.totalNet, a.totalNet, '全部實際淨損益加總');
    addRow('total_return', '總報酬率 Total Return', 'pct', t.totalReturnPct, a.totalReturnPct, '總淨利 / 本金');
    addRow('cagr', '年化報酬率 CAGR', 'pct', t.cagr, a.cagr, '以第一筆與最後一筆出場日期估算');
    addRow(null, '單筆波動（交易級 Volatility）', 'int', t.volPerTrade, a.volPerTrade, '單筆實際損益標準差');
    addRow('sharpe', 'Sharpe Ratio（交易級）', 'f2', t.sharpeTrade, a.sharpeTrade, '交易級 Sharpe');
    addRow('sortino', 'Sortino Ratio（交易級）', 'f2', t.sortinoTrade, a.sortinoTrade, '交易級 Sortino');
    addRow('calmar', 'Calmar Ratio', 'f2', t.calmar, a.calmar, '年化報酬率 / 最大回撤率');

    addSection('Tier 3．交易品質與結構（Trade Quality / Structure）');
    addRow(null, '交易筆數 #Trades', 'int', t.nTrades, a.nTrades, '完整進出場筆數');
    addRow('winrate', '勝率 Hit Rate', 'pct', t.winRate, a.winRate, '獲利筆數 / 總筆數');
    addRow(null, '平均單筆損益 Avg Trade PnL', 'int', t.avg, a.avg, '實際淨損益平均值');
    addRow(null, '平均獲利 Avg Win', 'int', t.avgWin, a.avgWin, '所有獲利單平均損益');
    addRow(null, '平均虧損 Avg Loss', 'int', t.avgLoss, a.avgLoss, '所有虧損單平均損益');
    addRow(null, '賺賠比 Payoff Ratio', 'f2', t.payoff, a.payoff, '平均獲利 / |平均虧損|');
    addRow(null, '單筆期望值 Expectancy', 'int', t.expectancy, a.expectancy, '每筆交易期望損益');
    addRow('pf', '獲利因子 Profit Factor', 'f2', t.pf, a.pf, '總獲利 / |總虧損|');
    addRow(null, '總獲利 Gross Profit', 'int', t.grossProfit, a.grossProfit, '所有獲利單損益加總');
    addRow(null, '總虧損 Gross Loss', 'int', t.grossLoss, a.grossLoss, '所有虧損單損益加總');
    addRow(null, '最大獲利單 Largest Win', 'int', t.largestWin, a.largestWin, '單筆最大實際獲利');
    addRow(null, '最大虧損單 Largest Loss', 'int', t.largestLoss, a.largestLoss, '單筆最大實際虧損');
    addRow(null, 'Kelly Fraction（理論值）', 'f2', t.kelly, a.kelly, '依勝率與賺賠比估算');

    addSection('Tier 4．路徑與穩定度（Path / Stability）');
    addRow(null, 'Equity Stability R²', 'f3', t.stabilityR2, a.stabilityR2, 'NAV 對時間回歸 R²');
    addRow(null, 'Alpha / Beta / Correlation', 'int', null, null, '需額外提供基準序列才可計算');

    addSection('Tier 5．成本、槓桿與執行（Cost / Turnover / Execution）');
    addRow(null, '交易天數 Trading Days', 'int', t.tradingDays, a.tradingDays, '有出場交易的日期數');
    addRow(null, '平均每日交易數 Trades / Day', 'f2', t.tradesPerDay, a.tradesPerDay, '交易筆數 / 交易天數');
    addRow(null, '平均持倉時間 Avg Holding Time（分鐘）', 'f1', t.avgHoldMin, a.avgHoldMin, '平均持有時間');
    addRow(null, '名目週轉率 Turnover（Notional / Capital）', 'f2', t.turnover, a.turnover, '進場合約名目價值 / 本金');
    addRow('cost_ratio', '成本佔交易金額比 Transaction Cost Ratio', 'pct', t.costRatio, a.costRatio, '手續費 + 稅 + 滑價 / 交易損益總量');
    addRow(null, '手續費總額 Total Commission', 'int', t.totalFee, a.totalFee, '所有交易手續費加總');
    addRow(null, '交易稅總額 Total Tax', 'int', t.totalTax, a.totalTax, '所有期交稅加總');
    addRow(null, '滑價成本總額 Slippage Cost', 'int', t.totalSlipCost, a.totalSlipCost, '依設定滑點換算');
    addRow(null, '總交易成本 Total Trading Cost', 'int', t.totalCost, a.totalCost, '手續費 + 稅 + 滑價');

    if (!badList.length) {
      badBody.innerHTML = '<tr><td colspan="5" style="color:#777;">目前沒有需要特別優化的指標。</td></tr>';
    } else {
      badBody.innerHTML = '';
      badList.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="kpi-name">${item.name}</td>
          <td class="num center ${item.ratingClass}">${item.valueStr}</td>
          <td class="center">建議優化</td>
          <td class="center ${item.ratingClass}">${item.ratingLabel}</td>
          <td class="center">${item.refRange}</td>
        `;
        badBody.appendChild(tr);
      });
    }

    const score = scoreCount > 0 ? (scoreSum / scoreCount) : null;
    renderScore(score);
  }

  function aggregateWeekly(dates, series, includeBaseline) {
    const outDates = [];
    const outVals  = [];
    let prevKey = null;
    let lastDate = null;
    let lastVal  = 0;

    for (let i = 1; i < series.length; i++) {
      const d = dates[i];
      if (!d) continue;
      const key = dateWeekKey(d);
      if (prevKey !== null && key !== prevKey) {
        outDates.push(lastDate);
        outVals.push(lastVal);
      }
      prevKey = key;
      lastDate = d;
      lastVal  = series[i];
    }
    if (lastDate != null) {
      outDates.push(lastDate);
      outVals.push(lastVal);
    }
    if (includeBaseline !== false && outDates.length > 0) {
      outDates.unshift(outDates[0]);
      outVals.unshift(0);
    }
    return { dates: outDates, vals: outVals };
  }

  function deriveWeeklyPnlsFromCumulative(vals) {
    if (!Array.isArray(vals) || !vals.length) return [];
    const out = [];
    for (let i = 0; i < vals.length; i++) {
      const curr = Number(vals[i]);
      if (!Number.isFinite(curr)) {
        out.push(null);
        continue;
      }
      if (i === 0) {
        out.push(curr);
        continue;
      }
      const prev = Number(vals[i - 1]);
      out.push(Number.isFinite(prev) ? curr - prev : curr);
    }
    return out;
  }

  function renderEquityChartWeekly(exitDates, totalTheo, totalAct,
                                   longTheo, longAct, shortTheo, shortAct,
                                   includeBaseline) {
    const canvas = document.getElementById('equityChart');
    if (!canvas || !window.Chart) return;
    const ctx = canvas.getContext('2d');

    const aggTotalTheo  = aggregateWeekly(exitDates, totalTheo, includeBaseline);
    const aggTotalAct   = aggregateWeekly(exitDates, totalAct, includeBaseline);
    const aggLongTheo   = aggregateWeekly(exitDates, longTheo, includeBaseline);
    const aggLongAct    = aggregateWeekly(exitDates, longAct, includeBaseline);
    const aggShortTheo  = aggregateWeekly(exitDates, shortTheo, includeBaseline);
    const aggShortAct   = aggregateWeekly(exitDates, shortAct, includeBaseline);

    const weekDates = aggTotalAct.dates;
    const labels    = aggTotalAct.vals.map((_, i) => String(i + 1));

    let maxVal = -Infinity, minVal = Infinity;
    let maxIdx = null, minIdx = null;
    for (let i = 1; i < aggTotalAct.vals.length; i++) {
      const v = aggTotalAct.vals[i];
      if (v > maxVal) { maxVal = v; maxIdx = i; }
      if (v < minVal) { minVal = v; minIdx = i; }
    }
    const maxMarker = aggTotalAct.vals.map((_, i) => (i === maxIdx ? aggTotalAct.vals[i] : null));
    const minMarker = aggTotalAct.vals.map((_, i) => (i === minIdx ? aggTotalAct.vals[i] : null));

    if (gChart) {
      gChart.destroy();
      gChart = null;
    }

    const tickIndexToLabel = {};
    if (weekDates.length > 0 && labels.length === weekDates.length) {
      const last = weekDates.length - 1;
      [0, 0.25, 0.5, 0.75, 1].forEach(r => {
        const idx = Math.round(last * r);
        const d   = weekDates[idx];
        if (!d) return;
        tickIndexToLabel[idx] = `${d.getFullYear()}/${d.getMonth() + 1}`;
      });
    }

    gEquityAxisSource = {
      dates: weekDates.slice(),
      labels: labels.slice(),
      tickIndexToLabel: { ...tickIndexToLabel },
      totalActVals: aggTotalAct.vals.slice(),
      weeklyPnls: deriveWeeklyPnlsFromCumulative(aggTotalAct.vals)
    };

    gChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '含滑價總損益', data: aggTotalAct.vals, borderColor: 'rgba(0,0,0,1)', backgroundColor: 'rgba(0,0,0,0)', borderWidth: 2, tension: 0, pointRadius: 0 },
          { label: '理論總損益',   data: aggTotalTheo.vals, borderColor: 'rgba(0,0,0,0.5)', backgroundColor: 'rgba(0,0,0,0)', borderWidth: 1, borderDash: [4, 3], tension: 0, pointRadius: 0 },
          { label: '多頭含滑價',   data: aggLongAct.vals, borderColor: 'rgba(220,0,0,1)', backgroundColor: 'rgba(0,0,0,0)', borderWidth: 1.5, tension: 0, pointRadius: 0 },
          { label: '多頭理論',     data: aggLongTheo.vals, borderColor: 'rgba(220,0,0,0.5)', backgroundColor: 'rgba(0,0,0,0)', borderWidth: 1, borderDash: [4, 3], tension: 0, pointRadius: 0 },
          { label: '空頭含滑價',   data: aggShortAct.vals, borderColor: 'rgba(0,150,0,1)', backgroundColor: 'rgba(0,0,0,0)', borderWidth: 1.5, tension: 0, pointRadius: 0 },
          { label: '空頭理論',     data: aggShortTheo.vals, borderColor: 'rgba(0,150,0,0.5)', backgroundColor: 'rgba(0,0,0,0)', borderWidth: 1, borderDash: [4, 3], tension: 0, pointRadius: 0 },
          { label: '期間最高點',   data: maxMarker, borderColor: 'rgba(220,0,0,0)', backgroundColor: 'rgba(220,0,0,1)', pointRadius: 4, pointHoverRadius: 5, showLine: false },
          { label: '期間最低點',   data: minMarker, borderColor: 'rgba(0,150,0,0)', backgroundColor: 'rgba(0,150,0,1)', pointRadius: 4, pointHoverRadius: 5, showLine: false }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            callbacks: {
              title: function (items) {
                const idx = items[0].dataIndex;
                const d = weekDates[idx];
                if (!d) return '';
                const y = d.getFullYear();
                const m = (d.getMonth() + 1).toString().padStart(2, '0');
                const day = d.getDate().toString().padStart(2, '0');
                return `${y}/${m}/${day}`;
              },
              label: function (ctx) {
                return `${ctx.dataset.label}: ${fmtInt(ctx.parsed.y)}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'category',
            display: true,
            offset: true,
            title: { display: true, text: '日期' },
            grid: {
              offset: true
            },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              stepSize: 1,
              callback: function (_value, index) {
                return tickIndexToLabel[index] || '';
              }
            }
          },
          y: {
            display: true,
            title: { display: true, text: '累積損益（金額）' },
            afterFit: function (scale) {
              scale.width = 78;
            }
          }
        }
      }
    });
  }

  function renderWeeklyPnlChart(weekDates, weekPnls, axisSource) {
    const canvas = document.getElementById('weeklyPnlChart');
    if (!canvas || !window.Chart) return;
    const ctx = canvas.getContext('2d');

    if (gWeeklyChart) {
      try {
        gWeeklyChart.destroy();
      } catch (err) {
        console.warn('weekly chart destroy warning', err);
      }
      gWeeklyChart = null;
    }

    const existingChart = typeof window.Chart.getChart === 'function'
      ? window.Chart.getChart(canvas)
      : null;
    if (existingChart) {
      try {
        existingChart.destroy();
      } catch (err) {
        console.warn('existing weekly chart destroy warning', err);
      }
    }

    if (!weekDates.length) return;

    let labels = weekDates.map((_, i) => String(i + 1));
    let refDates = weekDates.slice();
    let tickIndexToLabel = {};
    let alignedPnls = weekPnls.map((v) => (Number.isFinite(Number(v)) ? Number(v) : null));

    if (axisSource && Array.isArray(axisSource.dates) && axisSource.dates.length) {
      refDates = axisSource.dates.slice();
      labels = Array.isArray(axisSource.labels) && axisSource.labels.length
        ? axisSource.labels.slice()
        : axisSource.dates.map((_, i) => String(i + 1));
      tickIndexToLabel = { ...(axisSource.tickIndexToLabel || {}) };

      const pnlByWeekKey = new Map();
      for (let i = 0; i < weekDates.length; i++) {
        const d = weekDates[i];
        if (!d) continue;
        pnlByWeekKey.set(dateWeekKey(d), alignedPnls[i]);
      }

      alignedPnls = axisSource.dates.map((d) => {
        if (!(d instanceof Date)) return null;
        const key = dateWeekKey(d);
        return pnlByWeekKey.has(key) ? pnlByWeekKey.get(key) : null;
      });
    } else {
      const last = weekDates.length - 1;
      [0, 0.25, 0.5, 0.75, 1].forEach((r) => {
        const idx = Math.round(last * r);
        const d = weekDates[idx];
        if (!d) return;
        tickIndexToLabel[idx] = `${d.getFullYear()}/${d.getMonth() + 1}`;
      });
    }

    const barColors = alignedPnls.map((v) => {
      if (!Number.isFinite(v) || v === 0) return 'rgba(0,0,0,0)';
      return v > 0 ? 'rgba(220,0,0,0.8)' : 'rgba(0,150,0,0.8)';
    });
    const borderColors = alignedPnls.map((v) => {
      if (!Number.isFinite(v) || v === 0) return 'rgba(0,0,0,0)';
      return v > 0 ? 'rgba(220,0,0,1)' : 'rgba(0,150,0,1)';
    });
    const rightPadding = (
      gChart &&
      Number.isFinite(gChart.width) &&
      gChart.chartArea &&
      Number.isFinite(gChart.chartArea.right)
    ) ? Math.max(0, Math.round(gChart.width - gChart.chartArea.right)) : 0;

    gWeeklyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '每週損益',
            data: alignedPnls,
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
              title: function (items) {
                const idx = items[0].dataIndex;
                const d = refDates[idx];
                if (!d) return '';
                const y = d.getFullYear();
                const m = (d.getMonth() + 1).toString().padStart(2, '0');
                const day = d.getDate().toString().padStart(2, '0');
                return `${y}/${m}/${day}`;
              },
              label: function (ctx) {
                return `每週損益: ${fmtInt(ctx.parsed.y)}`;
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
              callback: function (_value, index) {
                return tickIndexToLabel[index] || '';
              }
            }
          },
          y: {
            display: true,
            title: { display: true, text: '每週損益（金額）' },
            grid: { zeroLineWidth: 1 },
            afterFit: function (scale) {
              scale.width = 78;
            }
          }
        }
      }
    });
  }

  function cloneRangeDate(d) {
    return d instanceof Date ? new Date(d.getTime()) : null;
  }

  function filterEquitySource(source, range) {
    if (!source) return null;
    if (!range) {
      return {
        dates: source.dates.slice(),
        totalTheo: source.totalTheo.slice(),
        totalAct: source.totalAct.slice(),
        longTheo: source.longTheo.slice(),
        longAct: source.longAct.slice(),
        shortTheo: source.shortTheo.slice(),
        shortAct: source.shortAct.slice()
      };
    }

    let baseTotalTheo = 0;
    let baseTotalAct = 0;
    let baseLongTheo = 0;
    let baseLongAct = 0;
    let baseShortTheo = 0;
    let baseShortAct = 0;

    for (let i = 0; i < source.dates.length; i++) {
      const d = source.dates[i];
      if (!d) continue;
      if (d.getTime() < range.start.getTime()) {
        baseTotalTheo = source.totalTheo[i];
        baseTotalAct = source.totalAct[i];
        baseLongTheo = source.longTheo[i];
        baseLongAct = source.longAct[i];
        baseShortTheo = source.shortTheo[i];
        baseShortAct = source.shortAct[i];
      }
    }

    const dates = [];
    const totalTheo = [];
    const totalAct = [];
    const longTheo = [];
    const longAct = [];
    const shortTheo = [];
    const shortAct = [];

    for (let i = 0; i < source.dates.length; i++) {
      const d = source.dates[i];
      if (!d) continue;
      const t = d.getTime();
      if (t < range.start.getTime() || t > range.end.getTime()) continue;
      dates.push(cloneRangeDate(d));
      totalTheo.push(source.totalTheo[i] - baseTotalTheo);
      totalAct.push(source.totalAct[i] - baseTotalAct);
      longTheo.push(source.longTheo[i] - baseLongTheo);
      longAct.push(source.longAct[i] - baseLongAct);
      shortTheo.push(source.shortTheo[i] - baseShortTheo);
      shortAct.push(source.shortAct[i] - baseShortAct);
    }

    return {
      dates,
      totalTheo,
      totalAct,
      longTheo,
      longAct,
      shortTheo,
      shortAct
    };
  }

  function filterWeeklySource(source, range) {
    if (!source) return null;
    if (!range) {
      return {
        dates: source.dates.slice(),
        pnls: source.pnls.slice()
      };
    }

    const dates = [];
    const pnls = [];
    for (let i = 0; i < source.dates.length; i++) {
      const d = source.dates[i];
      if (!d) continue;
      const t = d.getTime();
      if (t < range.start.getTime() || t > range.end.getTime()) continue;
      dates.push(cloneRangeDate(d));
      pnls.push(source.pnls[i]);
    }

    return { dates, pnls };
  }

  function buildAlignedWeeklySource(equitySource, weeklySource) {
    if (!equitySource || !weeklySource) return weeklySource;

    const aggEquity = aggregateWeekly(equitySource.dates, equitySource.totalAct);
    if (!aggEquity || !Array.isArray(aggEquity.dates) || !aggEquity.dates.length) {
      return weeklySource;
    }

    const pnlByWeekKey = new Map();
    for (let i = 0; i < weeklySource.dates.length; i++) {
      const d = weeklySource.dates[i];
      if (!d) continue;
      pnlByWeekKey.set(dateWeekKey(d), weeklySource.pnls[i] ?? null);
    }

    const dates = [];
    const pnls = [];

    aggEquity.dates.forEach((d, index) => {
      dates.push(cloneRangeDate(d));
      if (index === 0) {
        pnls.push(null);
        return;
      }
      pnls.push(pnlByWeekKey.has(dateWeekKey(d)) ? pnlByWeekKey.get(dateWeekKey(d)) : null);
    });

    return { dates, pnls };
  }

  function trimRangeLeadingWeekPoint() {
    if (!gChart || !gEquityAxisSource || !Array.isArray(gEquityAxisSource.dates) || gEquityAxisSource.dates.length < 2) {
      return;
    }

    const firstDate = gEquityAxisSource.dates[0];
    const secondDate = gEquityAxisSource.dates[1];
    if (!firstDate || !secondDate) return;
    if (dateWeekKey(firstDate) !== dateWeekKey(secondDate)) return;

    gEquityAxisSource = {
      dates: gEquityAxisSource.dates.slice(1),
      labels: gEquityAxisSource.labels.slice(1),
      totalActVals: Array.isArray(gEquityAxisSource.totalActVals) ? gEquityAxisSource.totalActVals.slice(1) : [],
      weeklyPnls: Array.isArray(gEquityAxisSource.weeklyPnls) ? gEquityAxisSource.weeklyPnls.slice(1) : [],
      tickIndexToLabel: Object.keys(gEquityAxisSource.tickIndexToLabel || {}).reduce((acc, key) => {
        const nextIndex = Number(key) - 1;
        if (Number.isFinite(nextIndex) && nextIndex >= 0) {
          acc[nextIndex] = gEquityAxisSource.tickIndexToLabel[key];
        }
        return acc;
      }, {})
    };

    gChart.data.labels = gChart.data.labels.slice(1);
    gChart.data.datasets.forEach((dataset) => {
      if (Array.isArray(dataset.data)) {
        dataset.data = dataset.data.slice(1);
      }
    });

    if (gChart.options && gChart.options.plugins && gChart.options.plugins.tooltip) {
      gChart.options.plugins.tooltip.callbacks = gChart.options.plugins.tooltip.callbacks || {};
      gChart.options.plugins.tooltip.callbacks.title = function (items) {
        const d = gEquityAxisSource.dates[items[0].dataIndex];
        if (!d) return '';
        const y = d.getFullYear();
        const m = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        return `${y}/${m}/${day}`;
      };
    }

    if (gChart.options && gChart.options.scales && gChart.options.scales.x && gChart.options.scales.x.ticks) {
      gChart.options.scales.x.ticks.callback = function (value, index) {
        return gEquityAxisSource.tickIndexToLabel[index] || '';
      };
    }

    gChart.update();
  }

  function buildDisplayedWeeklyPnlSource() {
    if (!gEquityAxisSource || !Array.isArray(gEquityAxisSource.dates) || !gEquityAxisSource.dates.length) {
      return null;
    }

    const dates = gEquityAxisSource.dates.slice();
    const labels = (
      Array.isArray(gEquityAxisSource.labels) &&
      gEquityAxisSource.labels.length === dates.length
    )
      ? gEquityAxisSource.labels.slice()
      : (
        Array.isArray(gChart && gChart.data && gChart.data.labels) &&
        gChart.data.labels.length === dates.length
      )
        ? gChart.data.labels.slice()
        : dates.map((_, i) => String(i + 1));

    if (
      Array.isArray(gEquityAxisSource.weeklyPnls) &&
      gEquityAxisSource.weeklyPnls.length === dates.length
    ) {
      return {
        dates,
        labels,
        tickIndexToLabel: { ...(gEquityAxisSource.tickIndexToLabel || {}) },
        pnls: gEquityAxisSource.weeklyPnls.map((v) => (Number.isFinite(Number(v)) ? Number(v) : null))
      };
    }

    const totalVals = (
      Array.isArray(gEquityAxisSource.totalActVals) &&
      gEquityAxisSource.totalActVals.length === dates.length
    )
      ? gEquityAxisSource.totalActVals.slice()
      : (
        gChart &&
        gChart.data &&
        Array.isArray(gChart.data.datasets) &&
        gChart.data.datasets[0] &&
        Array.isArray(gChart.data.datasets[0].data) &&
        gChart.data.datasets[0].data.length === dates.length
      )
        ? gChart.data.datasets[0].data.map((v) => (Number.isFinite(Number(v)) ? Number(v) : null))
        : [];

    if (!totalVals.length || totalVals.length !== dates.length) return null;

    const pnls = totalVals.map((curr, index) => {
      if (!Number.isFinite(curr)) return null;
      if (index === 0) return curr;
      const prev = totalVals[index - 1];
      return Number.isFinite(prev) ? curr - prev : curr;
    });

    return {
      dates,
      labels,
      tickIndexToLabel: { ...(gEquityAxisSource.tickIndexToLabel || {}) },
      pnls
    };
  }

  function hasRenderableWeeklyValues(source) {
    return !!(
      source &&
      Array.isArray(source.dates) &&
      source.dates.length &&
      Array.isArray(source.pnls) &&
      source.pnls.length === source.dates.length
    );
  }

  function syncWeeklyChartToDisplayedEquity(fallbackWeekly) {
    const displayedWeekly = buildDisplayedWeeklyPnlSource();
    if (hasRenderableWeeklyValues(displayedWeekly)) {
      renderWeeklyPnlChart(displayedWeekly.dates, displayedWeekly.pnls, displayedWeekly);
      return true;
    }

    const fallback = fallbackWeekly && Array.isArray(fallbackWeekly.dates) && Array.isArray(fallbackWeekly.pnls)
      ? fallbackWeekly
      : null;
    renderWeeklyPnlChart(fallback ? fallback.dates : [], fallback ? fallback.pnls : []);
    return !!(fallback && fallback.dates.length);
  }

  function renderStoredRange(range) {
    if (!gChartSource) return false;

    const eq = filterEquitySource(gChartSource.equity, range);
    const wk = filterWeeklySource(gChartSource.weekly, range);

    renderEquityChartWeekly(
      eq ? eq.dates : [],
      eq ? eq.totalTheo : [],
      eq ? eq.totalAct : [],
      eq ? eq.longTheo : [],
      eq ? eq.longAct : [],
      eq ? eq.shortTheo : [],
      eq ? eq.shortAct : [],
      !range
    );

    try {
      return syncWeeklyChartToDisplayedEquity(wk ? { dates: wk.dates, pnls: wk.pnls } : null);
    } catch (err) {
      console.error('single-trades range weekly sync error', err);
      return true;
    }
  }

  function renderTrades(parsed) {
    const tbody = $('#tradesBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    gChartSource = null;
    gEquityAxisSource = null;
    renderKpi(null, null);
    renderWeeklyPnlChart([], []);

    const paramLine = $('#paramLine');
    if (paramLine) {
      paramLine.textContent = (parsed && parsed.header) ? parsed.header : '';
    }

    if (!parsed || !parsed.trades.length) {
      if (gChart) { gChart.destroy(); gChart = null; }
      return;
    }

    let cumTheo   = 0;
    let cumActual = 0;

    const theoPnls   = [];
    const theoEquity = [];
    const actPnls    = [];
    const actEquity  = [];
    const dirs       = [];
    const exitDates  = [];

    const slipCostPerTrade = CFG.pointValue * CFG.slipPerSide * 2;

    parsed.trades.forEach((t, idx) => {
      cumTheo += t.theoNet;
      const actualNet = t.theoNet - slipCostPerTrade;
      cumActual += actualNet;

      theoPnls.push(t.theoNet);
      theoEquity.push(cumTheo);
      actPnls.push(actualNet);
      actEquity.push(cumActual);
      dirs.push(t.dir);
      exitDates.push(tsToDate(t.exit.ts));

      const tr1 = document.createElement('tr');
      const tr2 = document.createElement('tr');

      tr1.innerHTML = `
        <td rowspan="2">${idx + 1}</td>
        <td>${formatTs(t.entry.ts)}</td>
        <td>${fmtInt(t.entry.px)}</td>
        <td style="text-align:right;">${t.entry.action}</td>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      `;

      tr2.innerHTML = `
        <td>${formatTs(t.exit.ts)}</td>
        <td>${fmtInt(t.exit.px)}</td>
        <td style="text-align:right;">${t.exit.action}</td>
        <td class="${clsForNumber(t.points)}">${fmtSignedInt(t.points)}</td>
        <td>${fmtInt(t.fee)}</td>
        <td>${fmtInt(t.tax)}</td>
        <td class="${clsForNumber(t.theoNet)}">${fmtInt(t.theoNet)}</td>
        <td class="${clsForNumber(cumTheo)}">${fmtInt(cumTheo)}</td>
        <td class="${clsForNumber(actualNet)}">${fmtInt(actualNet)}</td>
        <td class="${clsForNumber(cumActual)}">${fmtInt(cumActual)}</td>
      `;

      tbody.appendChild(tr1);
      tbody.appendChild(tr2);
    });

    const kpiTheo = calcKpi(parsed.trades, theoPnls, theoEquity, 0);
    const kpiAct  = calcKpi(parsed.trades, actPnls, actEquity, CFG.slipPerSide);
    renderKpi(kpiTheo, kpiAct);

    const totalTheo = [0], totalAct = [0];
    const longTheo  = [0], longAct  = [0];
    const shortTheo = [0], shortAct = [0];

    let cumTotalTheo = 0, cumTotalAct = 0;
    let cumLongTheo  = 0, cumLongAct  = 0;
    let cumShortTheo = 0, cumShortAct = 0;

    for (let i = 0; i < theoPnls.length; i++) {
      const dir  = dirs[i];
      const tPnL = theoPnls[i];
      const aPnL = actPnls[i];

      cumTotalTheo += tPnL;
      cumTotalAct  += aPnL;

      if (dir > 0) {
        cumLongTheo += tPnL;
        cumLongAct  += aPnL;
      } else if (dir < 0) {
        cumShortTheo += tPnL;
        cumShortAct  += aPnL;
      }

      totalTheo.push(cumTotalTheo);
      totalAct.push(cumTotalAct);
      longTheo.push(cumLongTheo);
      longAct.push(cumLongAct);
      shortTheo.push(cumShortTheo);
      shortAct.push(cumShortAct);
    }

    const datesForChart = [exitDates[0] || new Date()];
    exitDates.forEach(d => datesForChart.push(d || exitDates[0]));

    renderEquityChartWeekly(datesForChart, totalTheo, totalAct, longTheo, longAct, shortTheo, shortAct, true);

    const weekMap = {};
    for (let i = 0; i < actPnls.length; i++) {
      const d = exitDates[i];
      if (!d) continue;
      const key = dateWeekKey(d);
      if (!weekMap[key]) {
        weekMap[key] = { sum: 0, date: d };
      } else if (d > weekMap[key].date) {
        weekMap[key].date = d;
      }
      weekMap[key].sum += actPnls[i];
    }

    const weekKeys = Object.keys(weekMap).sort();
    const weekDatesArr = [];
    const weekPnlsArr  = [];
    weekKeys.forEach(k => {
      weekDatesArr.push(weekMap[k].date);
      weekPnlsArr.push(weekMap[k].sum);
    });

    gChartSource = {
      equity: {
        dates: datesForChart.slice(),
        totalTheo: totalTheo.slice(),
        totalAct: totalAct.slice(),
        longTheo: longTheo.slice(),
        longAct: longAct.slice(),
        shortTheo: shortTheo.slice(),
        shortAct: shortAct.slice()
      },
      weekly: {
        dates: weekDatesArr.slice(),
        pnls: weekPnlsArr.slice()
      }
    };

    syncWeeklyChartToDisplayedEquity({ dates: weekDatesArr, pnls: weekPnlsArr });
  }

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

  async function loadAndRenderFile(file) {
    if (!file) return;

    try {
      const text = await readFileTextSmart(file);
      const parsed = parseTxt(text);
      gParsed = parsed;
      renderTrades(parsed);

      if (!parsed || !parsed.trades || !parsed.trades.length) {
        console.warn('[single-trades] no trades parsed; possible encoding or format mismatch');
      }
    } catch (err) {
      console.error('[single-trades] parse/render failed:', err);
      alert('檔案解析失敗：' + (err && err.message ? err.message : err));
    }
  }

  window.__singleTrades_setFile = function (f) {
    gFile = f || null;
  };

  window.__singleTrades_runFile = async function (f) {
    if (f) gFile = f;
    if (!gFile) return false;
    await loadAndRenderFile(gFile);
    return true;
  };

  window.__singleTrades_renderRange = function (range) {
    return renderStoredRange(range || null);
  };

  window.__singleTrades_renderAll = function () {
    return renderStoredRange(null);
  };

  window.__singleTrades_getDisplayedAxisSource = function () {
    if (!gEquityAxisSource) return null;
    return {
      dates: Array.isArray(gEquityAxisSource.dates) ? gEquityAxisSource.dates.map((d) => cloneRangeDate(d)) : [],
      labels: Array.isArray(gEquityAxisSource.labels) ? gEquityAxisSource.labels.slice() : [],
      tickIndexToLabel: { ...(gEquityAxisSource.tickIndexToLabel || {}) },
      totalActVals: Array.isArray(gEquityAxisSource.totalActVals) ? gEquityAxisSource.totalActVals.slice() : [],
      weeklyPnls: Array.isArray(gEquityAxisSource.weeklyPnls) ? gEquityAxisSource.weeklyPnls.slice() : []
    };
  };

  window.__singleTrades_getFullAxisSource = function () {
    if (!gChartSource || !gChartSource.equity) return null;

    const equity = gChartSource.equity;
    const weekly = gChartSource.weekly || { dates: [], pnls: [] };

    return {
      dates: Array.isArray(equity.dates) ? equity.dates.map((d) => cloneRangeDate(d)) : [],
      totalTheo: Array.isArray(equity.totalTheo) ? equity.totalTheo.slice() : [],
      totalAct: Array.isArray(equity.totalAct) ? equity.totalAct.slice() : [],
      longTheo: Array.isArray(equity.longTheo) ? equity.longTheo.slice() : [],
      longAct: Array.isArray(equity.longAct) ? equity.longAct.slice() : [],
      shortTheo: Array.isArray(equity.shortTheo) ? equity.shortTheo.slice() : [],
      shortAct: Array.isArray(equity.shortAct) ? equity.shortAct.slice() : [],
      weeklyDates: Array.isArray(weekly.dates) ? weekly.dates.map((d) => cloneRangeDate(d)) : [],
      weeklyPnls: Array.isArray(weekly.pnls) ? weekly.pnls.slice() : []
    };
  };

  window.__singleTrades_syncWeeklyToDisplayed = function () {
    const fallback = (
      gChartSource &&
      gChartSource.weekly &&
      Array.isArray(gChartSource.weekly.dates) &&
      Array.isArray(gChartSource.weekly.pnls)
    ) ? {
      dates: gChartSource.weekly.dates,
      pnls: gChartSource.weekly.pnls
    } : null;
    return syncWeeklyChartToDisplayedEquity(fallback);
  };

  const fileInput = $('#fileInput');
  const capitalInput = $('#capitalInput');
  const slipInput = $('#slipInput');
  const runBtn = $('#runBtn');

  if (fileInput) {
    fileInput.addEventListener('change', async function (ev) {
      const file = ev.target.files && ev.target.files[0];
      gFile = file || null;
      if (gFile) await loadAndRenderFile(gFile);
    });
  }

  if (capitalInput) {
    capitalInput.addEventListener('change', function () {
      const v = Number(this.value);
      if (isFinite(v) && v > 0) {
        CFG.capital = v;
        if (gParsed) renderTrades(gParsed);
      }
    });
  }

  if (slipInput) {
    slipInput.addEventListener('change', function () {
      const v = Number(this.value);
      CFG.slipPerSide = isFinite(v) ? v : 0;
      if (gParsed) renderTrades(gParsed);
    });
  }

  if (runBtn) {
    runBtn.addEventListener('click', async function () {
      if (!gFile) {
        alert('請先選擇 TXT 檔案');
        return;
      }
      await loadAndRenderFile(gFile);
    });
  }

})();
