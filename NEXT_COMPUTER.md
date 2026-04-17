# NEXT COMPUTER

Last updated: 2026-04-16

This folder can be copied directly to a new Windows machine.

## Copy Rule

Copy the entire folder:

- `C:\Users\user\Documents\mqquant`

## Structure

- `01`
  - fixed legacy 0313plus optimizer / exporter line
- `02`
  - modular 0313plus research / session line

## Important Difference Between 01 And 02

Do not assume they are the same strategy line.

- `01`
  - fixed legacy flow
  - uses local bundled source root by default under `01\bundle`
  - can also follow another source tree if `MQQUANT_SOURCE_ROOT` is set
- `02`
  - modular research flow
  - template mutation is enabled
  - default source root is `C:\xs_optimizer_v1`
  - on the old computer, that path was missing, so `02` was not fully certified there

## Shared Part

`01` and `02` share the same paired indicator / trading renderer wrapper layer (`xs_variants.py`).
That does not mean their full strategy runtime logic is the same.

## Read Order On The New Computer

1. `NEXT_COMPUTER.md`
2. `01\README.md`
3. `02\README.md`

## First Checks On The New Computer

### 01

```cmd
cd /d C:\Users\user\Documents\mqquant\01
run.cmd
```

If you want `01` to follow another source tree instead of the bundled one:

```cmd
set MQQUANT_SOURCE_ROOT=YOUR_SOURCE_ROOT
run.cmd
```

### 02

Before running `02`, confirm whether the new computer has:

- `C:\xs_optimizer_v1`

If not, set a compatible source root first:

```cmd
cd /d C:\Users\user\Documents\mqquant\02
set MQQUANT_SOURCE_ROOT=YOUR_SOURCE_ROOT
run.cmd
```

## What Was Recorded On 2026-04-16

- `01\README.md` was updated with fixed-line / bundled-root handoff notes
- `02\README.md` was updated with modular-flow / external-source-root handoff notes

## If A New Codex Session Starts Here

Tell it:

`Read mqquant/NEXT_COMPUTER.md first, then read 01/README.md and 02/README.md before assuming 01 and 02 are equivalent.`