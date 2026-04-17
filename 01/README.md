# MQQuant 01

這個資料夾是重新拆出的「固定策略參數最佳化」小程式。

重點：

- 不再依賴 `gui_app.py` 的 UI 主體
- 直接呼叫 `C:\xs_optimizer_v1\src\optimize\gui_backend.py`
- 目前預設以 `0313plus.xs`、`M1.txt`、`D1_XQ_TRUE.txt` 為主
- 可以切換 `智慧搜尋`、`單參數輪巡`、`完整網格`

啟動方式（CMD）：

```cmd
cd /d C:\Users\User\Documents\mqquant\01
run.cmd
```

如果原始專案不在 `C:\xs_optimizer_v1`，先設定：

```cmd
set MQQUANT_SOURCE_ROOT=你的原始專案路徑
run.cmd
```

## 2026-04-16 Audit For Computer Switch

- This project is not a git repo by itself.
- Runtime purpose: fixed 0313plus optimizer / exporter flow.
- Source root resolution order:
  1. `MQQUANT_SOURCE_ROOT`
  2. local bundled root under `01\bundle`
- Current machine check:
  - `01\bundle` exists and contains `src`, `strategy`, `run_history`, and market data.
  - `mq01\xs_variants.py` hash matches `mq02\xs_variants.py`, so the paired indicator / trading renderer layer is the same in both wrappers.
  - `bundle\src\strategy\strategy_0313plus.py` hash matches `xs-core-engine\references\legacy-01\python\strategy\strategy_0313plus.py`.
- Conclusion:
  - `01` is the fixed legacy strategy line.
  - indicator and trading outputs come from the same base XS logic, with trading only adding execution commands.
- Handoff reminder for the next computer:
  - if you want `01` to stay self-contained, keep using the bundled source root.
  - if you want it to follow another source tree, set `MQQUANT_SOURCE_ROOT` before `run.cmd`.