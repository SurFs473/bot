# Mean-Reversion Bot — Command Reference

Every command is given for both **PowerShell** (Windows default) and **Git Bash**. Pick your shell and use that block — don't mix them.

> **Key differences:**
> - **PowerShell** sets settings with `$env:VAR="value"; …` and they **persist** for that terminal session (a leftover from a previous line can change a run — open a fresh terminal if a mode acts odd).
> - **Git Bash** sets them inline as `VAR=value …` on the same line; they **don't persist** (cleaner, per-command).
> - Setting a variable **prints nothing** — that's normal. The `npm run …` part is what actually runs.

## Folders

| Purpose | PowerShell path | Git Bash path |
|---|---|---|
| TS bot + MT5 gateway | `C:\Users\nikol\OneDrive\Desktop\bots\cursor\bot` | `/c/Users/nikol/OneDrive/Desktop/bots/cursor/bot` |
| Python model | `C:\Users\nikol\OneDrive\Desktop\bots\hg-boost` | `/c/Users/nikol/OneDrive/Desktop/bots/hg-boost` |

## Which commands need a server running?

| Command | Needs running |
|---|---|
| `generate`, `dashboard` | nothing |
| `filter`, `sweep` | model server (step 5) |
| `mr-live` | MT5 gateway (step 10); model server only if `USE_ML_FILTER=true` (it's off) |

---

## 📊 Backtest — folder: `cursor/bot` (no server needed)

**Go to the folder:**
```powershell
cd C:\Users\nikol\OneDrive\Desktop\bots\cursor\bot
```
```bash
cd /c/Users/nikol/OneDrive/Desktop/bots/cursor/bot
```

**1 — Build the dataset + see the raw edge** (writes `ml_dataset.csv`, prints WR/expectancy + the $1k account sim):
```powershell
$env:MR_MODE="generate"; $env:EXIT_MODE="trail"; npm run mean-reversion
```
```bash
MR_MODE=generate EXIT_MODE=trail npm run mean-reversion
```

**2 — Compare exits** (old full-mean vs new trailing):
```powershell
$env:MR_MODE="generate"; $env:EXIT_MODE="full";  npm run mean-reversion
$env:MR_MODE="generate"; $env:EXIT_MODE="trail"; npm run mean-reversion
```
```bash
MR_MODE=generate EXIT_MODE=full  npm run mean-reversion
MR_MODE=generate EXIT_MODE=trail npm run mean-reversion
```

---

## 🤖 Model — folder: `hg-boost` (only if you want the ML filter)

**Go to the folder + activate the Python venv:**
```powershell
cd C:\Users\nikol\OneDrive\Desktop\bots\hg-boost
.\venv\Scripts\Activate.ps1
```
```bash
cd /c/Users/nikol/OneDrive/Desktop/bots/hg-boost
source venv/Scripts/activate
```

**3 — Train the model** (uses the `ml_dataset.csv` from step 1 → `model.json`) — same in both shells:
```bash
python train.py
```

**4 — (optional) XGBoost vs CatBoost comparison** — same in both:
```bash
python train_compare.py
```

**5 — Serve the model** (leave running in its own terminal) — same in both:
```bash
python -m uvicorn main:app --port 8000
```

---

## 🔎 Filtered backtest — folder: `cursor/bot` (needs step 5 running)

**6 — Run the ML-filtered strategy on the test year:**
```powershell
$env:MR_MODE="filter"; $env:EXIT_MODE="trail"; $env:EV_MARGIN="0.15"; npm run mean-reversion
```
```bash
MR_MODE=filter EXIT_MODE=trail EV_MARGIN=0.15 npm run mean-reversion
```

**7 — Sweep the thresholds** (EV grid + win-probability grid):
```powershell
$env:MR_MODE="sweep"; $env:EXIT_MODE="trail"; npm run mean-reversion
```
```bash
MR_MODE=sweep EXIT_MODE=trail npm run mean-reversion
```

---

## 📈 Dashboard — folder: `cursor/bot` (no server needed)

**8 — Export the dashboard data:**
```powershell
$env:MR_MODE="dashboard"; $env:EXIT_MODE="trail"; npm run mean-reversion
```
```bash
MR_MODE=dashboard EXIT_MODE=trail npm run mean-reversion
```

Optional — chart a different market (stats stay all-basket):
```powershell
$env:MR_MODE="dashboard"; $env:CHART_SYMBOL="GER40"; npm run mean-reversion
```
```bash
MR_MODE=dashboard CHART_SYMBOL=GER40 npm run mean-reversion
```

**9 — Open the dashboard:**
```powershell
start .\back-test\dashboard.html
```
```bash
start back-test/dashboard.html
```

---

## 🟢 Live on DEMO — needs the MT5 gateway

**10 — Start the MT5 gateway** (connects to your demo; own terminal) — folder: `cursor/bot`:
```powershell
cd C:\Users\nikol\OneDrive\Desktop\bots\cursor\bot
python mt5_connect_test.py
```
```bash
cd /c/Users/nikol/OneDrive/Desktop/bots/cursor/bot
python mt5_connect_test.py
```

**11 — Watch it safely** (prints signals/orders/trails, sends NOTHING):
```powershell
$env:DRY_RUN="true"; npm run mr-live
```
```bash
DRY_RUN=true npm run mr-live
```

**12 — Actually trade the demo** (only after step 11 looks right):
```powershell
$env:DRY_RUN="false"; npm run mr-live
```
```bash
DRY_RUN=false npm run mr-live
```

---

## `EXIT_MODE` — the two strategies (both kept)

| | `full` (old) | `trail` (new, default) |
|---|---|---|
| Win rate | 22% | 44% |
| Avg win | +3.7R | +1.6R |
| Biggest win | +26R | +23R |
| Expectancy | +0.043R | +0.143R |
| Profit factor | 1.06 | 1.26 |
| Flat 1% max drawdown | **~113% → blows the account** | **~19% → survivable** |

`full` = hard take-profit at the mean (low WR, huge payoffs, but drawdown bigger than the account). `trail` = ratcheting stop that banks profit early (survivable). Switch with `EXIT_MODE` on any command above.

---

## Typical flows

- **First look:** step 1 → step 8 → step 9 (see the dashboard).
- **With the ML filter:** step 1 → step 3 → step 5 → step 6.
- **Go live on demo:** step 10 → step 11 → step 12.

> All backtest numbers are **gross of spread/commission** — the demo is what tells you the real net edge.
