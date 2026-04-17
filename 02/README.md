# MQQuant 02

這個資料夾是重新拆出的「0313plus 模組化研究循環」小程式。

重點：

- 不再把研究流程 UI 塞進 `gui_app.py`
- 直接接 `src/research/*`
- 以 `0313plus` modular loop 為固定路徑
- 啟動後會用背景 worker 跑 session
- 可以看狀態、Top runs、最近 runs、模組學習摘要、參數學習摘要

啟動方式（CMD）：

```cmd
cd /d C:\Users\User\Documents\mqquant\02
run.cmd
```

如果原始專案不在 `C:\xs_optimizer_v1`，先設定：

```cmd
set MQQUANT_SOURCE_ROOT=你的原始專案路徑
run.cmd
```

## 2026-04-16 Audit For Computer Switch

- This project is not a git repo by itself.
- Runtime purpose: modular 0313plus research / session workflow, not the same fixed strategy line as `01`.
- Current machine check:
  - `mq02\xs_variants.py` hash matches `mq01\xs_variants.py`, so the paired indicator / trading renderer layer is the same.
  - `mq02\config.py` enables `allow_template_mutation = True` and `exploration_mode = "modular_loop"`.
  - `mq02\services.py` imports `src.research.modular_0313plus`.
  - `mq02\bootstrap.py` defaults to `C:\xs_optimizer_v1`.
  - On this machine, `C:\xs_optimizer_v1` is missing.
- Conclusion:
  - `02` cannot be certified as logic-identical to `01`.
  - `02` is the modular research path and needs a valid external source root before use.
- Handoff reminder for the next computer:
  - restore `C:\xs_optimizer_v1`, or
  - set `MQQUANT_SOURCE_ROOT` to a compatible source tree before `run.cmd`.