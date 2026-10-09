# Candle-spread engine: settings reference (operator)

**As of 2026-10-08 · describes commit `b3b0433`.** The code is the source of truth. Citations are `file:line` at that commit.
Paths are relative to `server/src/` unless noted. `$PROD` = the prod CloudFront origin (the default in `scripts/check-token-health.js`).

> **MOST LIKELY TO NEED**
> 1. **Floor raise off:** `CANDLE_SPREAD_FLOOR_RAISE=off`. Use `sim` to keep it on everywhere except the armed variant.
> 2. **Stall cover / late-day guard off:** `CANDLE_SPREAD_STALL_COVER=off` / `CANDLE_SPREAD_LATE_FLOOR=off`
> 3. **Give-up off:** `CANDLE_SPREAD_GIVEUP=none`
> 4. **Stop trading now, no restart:** open `$PROD/control` and tap **HALT** (sends nothing; cancels still go through) or **WIND DOWN** (opens nothing new; keeps covering).
> 5. **Token:** `GET $PROD/health?t=<anything>`, then read `schwabToken.state` and `daysLeft`. Or run `node scripts/check-token-health.js`. To renew, run `node scripts/renew-schwab-token.js`, then set the same two values on EB.
>
> On EB, a changed env var restarts the app. Items 1-3 take effect **right after that restart, even mid-session**, because the trader reads them from `deps`.

---

## 0. When does a change take effect?

| Channel | How to change | Takes effect |
|---|---|---|
| **Env var** | EB console → Configuration → Environment properties, or `eb setenv K=V` | Restarts the app. The roster (`VARIANTS`) is rebuilt from env at boot. Nothing is managed during the restart gap. |
| **(a) `deps` value** | env var, then restart | **Immediately after the restart, mid-session included.** `buildEngineDeps(run)` (`candle-spread/index.js:1809`) is rebuilt from the **current** roster on every pass. |
| **(b) `cfg` value** | env var, then restart | **Next session.** The trader reads `cfg = record.config` (`trader.js:1440`). That config is sealed at the day's first event, normally the 09:35 tick. `refreshUntouchedConfig` (`index.js:1969`) only updates a record that has no events and no positions yet. |
| Floor raise | env var, then restart | **Immediate.** It is in `cfg` but rides `deps.floorRaiseCfg` (`index.js:1845`), which `trader.raiseFloor` merges over the sealed config (`trader.js:1297`). |
| **Control file** | `/control` page, control API, or hand-edit in S3 | Within **~20 s** with no restart. It is re-read on every order poll (`index.js:2373`), and senders resolve the mode per order. |
| **Code constant** | deploy (= restart) | Same (a)/(b) split. A `deps` field such as a cap applies at deploy, mid-session included. A `cfg` field such as placement or re-strike applies the next session. |

Already-resting orders keep the price they were placed at. A new minLock, for example, changes covers placed **after** the restart.

---

## 1. Environment variables

**(a)** = read via `deps`, so it applies after the restart, mid-session included. **(b)** = read via sealed `record.config`, so it applies next session. **boot/proc** = a process-level constant that applies after the restart.

### 1.1 Arming & safety

| Var | What it does | Values · default | Touches | When |
|---|---|---|---|---|
| `CANDLE_SPREAD_LIVE` | **Master switch.** No real order (test or live) reaches Schwab unless this is set. It is also what lets the control file honour `mode:'live'`. | exactly `true` · **unset = off** (`index.js:1368`) | all senders | boot/proc. Senders check it per order. |
| `CANDLE_SPREAD_ARMED` | Which **one** variant may send. Any name not on the roster arms nothing (logged at boot; `/status` `gates.armedSelectionValid:false`). It is also the default target of control presets and the variant `FLOOR_RAISE=sim` exempts. | variant name · `v7-10` (`index.js:311`) · `none` = arm nothing | one variant | (a) `deps.dryRun` + senders. ⚠ Do not re-arm mid-session (see §5). |
| `CANDLE_SPREAD_ARMED_MODE` | The armed variant's **ceiling**. `live` sends real, fillable orders. Any other value sends real orders at an unfillable price and auto-cancels them ("paper"/"test"). | `live` · **default `test`** (`index.js:471`) | armed variant | (a) |
| `CANDLE_SPREAD_DISABLED` | The engine does not start at all: no ticks, **no order poll, no settlement**. | exactly `true` · unset (`index.js:2897`) | everything | boot. ⚠ Live orders already resting at Schwab go **unmanaged**. Use control HALT instead. |
| `CANDLE_SPREAD_WATCHLIST` | UI highlight only. The engine ignores it. | comma list · `v1-10,v2-10,v6-10` (`index.js:51`) | UI | boot |
| `CANDLE_SPREAD_CONTROL_TOKEN` | Enables the control **write** API and the page's buttons. If unset, POST returns 503 and the S3 file can still be edited by hand. Never in a URL: send it as the `x-control-token` header or the body `token`. | secret string · unset = write API off (`index.js:3108`) | control | boot |
| `CANDLE_SPREAD_CONTROL_TIMEOUT_MS` | Timeout for the S3 read of the control file. On a timeout the last known state stays in force. | ms · `8000` (`strategy-control.js:213`) | control | proc |
| `CANDLE_SPREAD_TEST_FRAC` | In test mode, a debit is sent at this fraction of its price and a credit is divided by it. Values outside (0,1) fall back to 0.1 and log an error. | (0,1) · `0.1` (`index.js:1429`) | test-mode sends | proc |
| `CANDLE_SPREAD_TEST_CANCEL_MS` | The poller cancels a test-mode order after this long. | ms · `60000` (`index.js:1437`) | test-mode sends | proc |

**Real send requires all of these** (`index.js:1496,1642,1710`): `isProd`, `LIVE=true`, the trading client, `ACCOUNT_HASH`, and an effective mode of paper or live. `isProd` means `NODE_ENV` is set and is not `development`. Anything short of that is simulated and logged `order_simulated` with a reason: `dryRun` / `dev-mode` / `disarmed` / `no-client`.

### 1.2 Strategy features

| Var | What it does | Values · default | Touches | When |
|---|---|---|---|---|
| `CANDLE_SPREAD_FLOOR_RAISE` | Floor raise: buys the best near-money floor lift at ≥3:1, spreads first. | `all` (default) · `off` · anything else behaves like `sim` (every variant except the armed one) (`index.js:841`) | all variants | **(a)**, via `deps.floorRaiseCfg` |
| `CANDLE_SPREAD_STALL_COVER` | Stall cover: if the position is not in the money 15 min after its fill, the cover goes to break-even. | `off` disables · default on, 15 min (`index.js:868`) | all | (a) `deps.stallCoverMin` |
| `CANDLE_SPREAD_LATE_FLOOR` | Late-day guard: from 15:00 ET, a floor that is ≥ 0 may not go negative. It blocks opens, raises, and floor-lowering covers. | `off` disables · default on (`index.js:874`) | all (incl. `-unc`) | (a) `deps.lateFloorAfterMin` |
| `CANDLE_SPREAD_GIVEUP` | Give-up: once the underlying is 10 pts through the short strike, the cover goes to the market, capped at a loss of 5/7.5/10% of W. | `all` (default/unset) · `none` · comma list. An empty string = none (`index.js:430`). | all | (a) `deps.coverGiveUp` |
| `CANDLE_SPREAD_LADDER` | **Adds** the cover+open ladder to the named variants. It cannot remove the ladder (use `MINLOCK_CTL` for that). | comma list · empty (`index.js:358`) | named | (a) |
| `CANDLE_SPREAD_MINLOCK` | Per-variant minLock override, on top of the width rule. | `v:frac` or `v:frac+L` (+L adds the ladder), comma list · empty (`index.js:406`) | named | (a) covers placed after the restart |
| `CANDLE_SPREAD_MINLOCK_CTL` | Control **cells** that get **no ladder**. minLock still follows the width rule. A cell covers the base variant and its `-unc` twin. | cells `vX-W` · empty since 2026-10-09 (`index.js:631`) | those cells | (a) |
| `CANDLE_SPREAD_OPEN_BAND_HIGH` / `CANDLE_SPREAD_OPEN_BAND_LOW` | Open price band on every adaptive variant: 50% of width ± these fractions. HIGH is the cap and the walk ceiling (the most an open ever pays). LOW only LABELS a cheap placement (`belowBand` on the `open` decision); a cheap placement is never refused, it is placed at its mark and walked up. | fraction for all widths (`0.05`) or per width (`10:0.05,20:0.075,40:0.1`) · default 0.05 / 0.05 → 10W $4.50–5.50, 20W $9–11, 40W $18–22 (`index.js` `PLACEMENT_G`) | adaptive variants | boot |
| `CANDLE_SPREAD_FLOOR_FOLD` | Floor-repair fold (2026-10-09): wings and must-fix offsets run as stages of floor raise (`raise-wing`, `raise-cap`); stand-alone wings, offsets and fly repair are off wherever floor raise is on. | `on` (default) · `off` restores the legacy hedgers (`index.js` `applyFloorRepairFold`) | variants with floor raise | (a) |
| `CANDLE_SPREAD_FLY` | **Legacy** (inactive while the floor-repair fold is on). Fly/condor valley repair: ratio 3, 1.5σ band, $1,500 budget, ≤4/day, before 15:00. | comma list. Default = all v0/v2/v4/v6/v8 capped variants plus `v7-10-unc,v7-20-unc,v7-40-unc,v6-40-unc,v0-40-unc` (`index.js:568`). Use `none` to disable (it is logged as a harmless config problem). | named | (a) |
| `CANDLE_SPREAD_RATCHET` | Floor ratchet: limits how far the floor may retreat from its peak. Rejected and **off** fleet-wide. | `v:frac` with 0<frac<1 (frac omitted = 0.25) · empty (`index.js:1054`) | named | (a) |
| `CANDLE_SPREAD_CAPPRES` | Sets lossMax = 1×W×100. **Inert at HEAD:** all 4 default names have a tuned cap that overrides it. On any other variant it ends up at the 1.5×W floor. `-unc` names are refused. | comma list · `v7-10,v3-10,v6-20,v7-40` (`index.js:468`) | named | (a) `deps.lossMax` |
| `CANDLE_SPREAD_CREDIT_TRIGGER_XW` | Fires credit orders to reclaim deployed capital above this×W×100 ($250/$500/$1,000). `0` (or non-numeric) restores open-alternate-every-3 + creditCoverFrac 0.65. | number · `0.25` (`index.js:707`) | all | (a) |
| `CANDLE_SPREAD_ORDERSLIP` | Ticks paid over the mark. | `v:ticks` (int ≥0) · empty = 0 (`index.js:590`) | named | **mixed:** opens (b) via `cfg` (`trader.js:595,2067`); offsets/wings/flies (a) |
| `CANDLE_SPREAD_SIM_FILL` | `legacy` turns off simulated-fill realism (open needs 2 looks, cover 1 tick through, fills at limit). It does nothing for the broker-filled armed variant. | `legacy` · default realism on (`index.js:825`) | all simulated | **mostly (b).** `simOpenFillMinLooks`, `coverFillThroughTicks` and resting-cover `simFillAtLimit` come from `cfg`; mark-path hedges/opens `simFillAtLimit` come from `deps` |

Unknown names in any list → `[candle-spread] CONFIG PROBLEMS` at boot and `/status` `configProblems` (`index.js:1251`). Those variants run at their defaults.

### 1.3 Timing

| Var | What | Default | When |
|---|---|---|---|
| `CANDLE_SPREAD_POLL_MS` | Order poll interval: broker fills, test cancels, stale sweep. **Also the control-file refresh interval.** | `20000` (`index.js:1438`) | proc |
| `CANDLE_SPREAD_WORK_MS` | Sub-bar pass over resting opens and covers (ladder steps, give-up, stall, fill checks between candles). RTH only. | `30000` (`index.js:2232`) | proc |

The candle scheduler is fixed in code: 5-min steps, first action 09:35, last 15:55, EOD settlement attempted 16:00-16:30 ET.

### 1.4 Storage / S3

| Var | What | Default | When |
|---|---|---|---|
| `CANDLE_SPREAD_RUNS_DIR` | Local run-record store | code: `server/src/persistence/candle-spread-runs` (`candle-spread/store.js:30`). EB sets `/var/optioncalc-data/candle-spread-runs` (`server/.ebextensions/persistence.config`). | boot |
| `CANDLE_SPREAD_S3_BUCKET` | Enables the off-instance archive (write-through + rehydrate on boot). **It is also where the control file lives.** If unset, there is no archive and **no remote control**. | unset (`run-archive.js:31`). Set on the EB environment, not in the repo. | boot |
| `CANDLE_SPREAD_S3_PREFIX` | Key prefix. The control file is `<prefix>/_control/strategy-control.json`. ⚠ Changing it orphans the control file **and any halt in it**. | `candle-spread-runs` (`run-archive.js:32`) | boot |
| `CANDLE_SPREAD_S3_MAX_INFLIGHT` | Concurrent uploads | `3` (`store.js:168`) | boot |
| `CANDLE_SPREAD_S3_RESTORE_DAYS` | History days restored for the UI, in the background behind the engine | `0` = today only (`index.js:2734`) | boot |
| `CANDLE_SPREAD_SEED_BUNDLE` / `_SEED_BUNDLE_KEY` | One-shot history seed from a deploy-shipped bundle or an S3 key. It never overwrites and runs once per bundle. | `<app>/seed-runs.tgz` / `_seed/seed-runs.tgz` (`seed-bundle.js:40,53`) | boot |
| `AWS_REGION` → `AWS_DEFAULT_REGION` | S3 client region | `us-east-1` (`run-archive.js:33`) | boot |
| `NQ_NDX_BASIS_PATH` | Held NQ↔NDX basis file | OS tmpdir. EB sets `/var/optioncalc-data/nq-ndx-basis.json`. | boot |

### 1.5 Caches (UI/HTTP only; the engine's chain fetch does not use them)

| Var | What | Default |
|---|---|---|
| `CHAINS_CACHE_TTL_MS` | `/api/v1/marketdata/chains` response cache (`proxy-server-sdk.js:31`) | `3000` |
| `ANALYSIS_CACHE_TTL_MS` | `/marketdata/candleanalysis` cache (`proxy-server-sdk.js:32`) | `4000` |

### 1.6 Schwab auth & process

| Var | What | Notes |
|---|---|---|
| `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET` | App credentials | read at startup |
| `SCHWAB_REFRESH_TOKEN` | Refresh token, lasting ~7 days | read at startup, so a new token needs a restart. **EB's copy is separate from local `.env`.** |
| `SCHWAB_REFRESH_TOKEN_ISSUED_AT` | ISO time the token was minted. Drives `/health` `daysLeft`. | If unset, the age is "first seen by this server" (`issuedAtObserved:true`) or `ageUnknown:true` (`schwab-token-health.js:69`). |
| `SCHWAB_TOKEN_STATE_DIR` | Directory for `schwab-token-state.json`, which holds the token fingerprint and first-seen time | Fallback order: this → `/var/optioncalc-data` → `~/.optioncalc` → `/tmp` |
| `ACCOUNT_HASH` | Account for orders. Missing = no real sends (`no-client`). | name only, never print |
| `NODE_ENV` | `production` on EB. Unset or `development` = dev mode, which **never sends** and enables `/api/v1/dev/*`. | `proxy-server-sdk.js:56,1542` |
| `PORT` | Listen port | `3001`. EB sets `8080`. |

Not operational: `CANDLE_BACKTEST_CACHE_DIR/_MAX` and `CANDLE_REPLAY_DIR/_MAX` are backtest only. `AWS_ELASTIC_BEANSTALK_ENVIRONMENT_NAME`, `AWS_ELASTICBEANSTALK_ENVIRONMENT_NAME` and `EC2_INSTANCE_ID` are read only by `persistence/eb-persistence.js`, which nothing requires.

---

## 2. Remote control (no restart)

**What:** `<S3_PREFIX>/_control/strategy-control.json` in the archive bucket. The engine re-reads it every order poll (~20 s). Code: `candle-spread/strategy-control.js`, page `pages/control.html`, routes `proxy-server-sdk.js:1132-1167`.

```json
{ "variants": { "v7-10": { "mode": "live", "restrict": "no-open", "note": "why", "until": "2026-10-09" } } }
```

| Field | Values | Meaning |
|---|---|---|
| `mode` | `simulate` · `paper` · `live` | What the variant *is*: no broker contact / real orders at unfillable prices / real fillable orders. |
| `restrict` | `no-open` · `halt` · absent | What it may *do* now. It only ever subtracts. |
| `until` | `YYYY-MM-DD` (ET) | After that date the entry is ignored and the variant reverts to its roster mode. The entry is valid **through** the date. |

**The file can only lower, never raise** (`strategy-control.js:68,155-167`):
- `live` is honoured only if `CANDLE_SPREAD_LIVE=true`. Otherwise it is downgraded to paper.
- No variant can exceed its **roster** mode, which is set by `CANDLE_SPREAD_ARMED` + `_ARMED_MODE`. Every unarmed variant is `simulate`, so the file **cannot make a second variant paper or live**. Raise a ceiling with env vars.
- A variant not listed in the file runs its roster mode. With the defaults, that means the armed variant is paper, not simulate.
- If the file is **absent**, every variant runs its roster mode. If it is **unreadable, malformed or timed out**, the **last good state is kept** (a halt survives a bad edit). If there is **no S3 bucket**, there is no control at all.

### What `no-open` and `halt` actually do (verified)

| | **no-open** (`wind-down`) | **halt** |
|---|---|---|
| New opens | Refused at the decision → `open-skip-control` (`trader.js:1725`) | Refused (same) |
| Working (unfilled) open | **Frozen**, not walked → `open-rest` "brake" (`trader.js:3050`). Not cancelled, so it **can still fill**. The 10-min re-strike and the 90-min stale backstop can still cancel it. | Same, and any replace is refused |
| Covers, ladder, give-up, stall | **Keep running** | **Refused at the sender:** every place and replace → `order_control_blocked` (`index.js:1471-1491,1693-1705`). Uncovered positions **stay uncovered**. |
| Floor raises / wings / flies / offsets | **Keep running.** These are new debit hedges. | Refused |
| Cancels | Allowed | **Allowed**, including strategy cancels, re-strike and test auto-cancel |
| Orders already resting at Schwab | Keep working | **Stay at their current price and can still fill.** The poller still books fills. |
| Simulated variants | Same rules | Same rules. The halted sim gets `filled:false`. |

So **WIND DOWN is the reflex** when you are unsure: it stops new risk and keeps covering. **HALT is the fire alarm**: nothing new reaches Schwab, including covers. To clear working orders, also cancel them, or let the engine do it after `resume`.

### How to use it

| Action | How |
|---|---|
| Phone | `$PROD/control`. Paste the token once (it is stored in that browser's localStorage). Buttons: **HALT**, **WIND DOWN** (one tap); **RESUME / PAPER / LIVE / OFF / CLEAR** (confirm first). The buttons always target the **armed** variant. |
| curl | `curl -X POST -H "x-control-token: $TOK" $PROD/api/v1/candle-spread/control/halt` (add `?variant=v6-20` for another variant). Presets are at `index.js:3207`. |
| Full API | `POST /api/v1/candle-spread/control` with `{variant, mode, restrict, note, until}`, `{variant, remove:true}`, or `{variants:{...}}`. The roster is validated before writing. |
| Read | `GET /api/v1/candle-spread/control` (no auth) or `/api/v1/candle-spread/status` → `gates.strategyControl` |
| No token | Edit the JSON in the S3 console. **Write the variant's current mode** with the restrict, e.g. `"v7-10":{"mode":"live","restrict":"halt"}`. Writing `simulate` demotes it. |

The presets: `halt` / `wind-down` / `no-open` / `resume` **keep the current mode**. `off` writes `simulate`, which overrides an env arming downward. `clear` removes the entry, so the roster mode applies again. `paper` and `live` request that mode, subject to the clamp above.

---

## 3. Roster settings that are code, not env (`candle-spread/index.js`)

Changing any of these needs a deploy. **Kill** = an env switch exists. **Mid-session** = whether a deploy changes a session already under way.

| Setting | Current value | Where | Kill | Mid-session |
|---|---|---|---|---|
| **Armed variant** | `v7-10`, mode `test` unless `ARMED_MODE=live` | `:311,471` | env | (a) |
| **Loss cap** lossMax / lossTarget | Per-variant `TUNED_CAPS`. lossTarget = 0.7×lossMax. Then **ceiling $7,500**, then **floor 1.5×W** ($1,500/$3,000/$6,000). **All 10-wides $2,000.** | `:710,527,552` | none (`CAPPRES` can only push toward the floor) | (a) `deps.lossMax` |
| Uncapped twins `-unc` | No governor (lossMax null) | `buildUncapped` | none | (a) |
| **Placement G** (adaptive variants and `-unc`; not `-cATM`) | Deepest-ITM placement at or under the cap (50% + 5% of width: 10W $5.50 · 20W $11 · 40W $22), walked no higher than the cap; max 1 strike OTM, max 3 ITM. Under the band floor (45%) it is still placed, at its mark, labelled `belowBand` (2026-10-09; was 10W $4.80-5.30 → $5.50, 20W $9.50-11 → $11.50, 40W $19-23 → $24, cheap placements refused). | `PLACEMENT_G` | `OPEN_BAND_HIGH` / `OPEN_BAND_LOW` | (b) |
| **minLock** (cover asks for at least this profit) | 0.10×W at 10W, 0.20×W at 20/40W, every cell | `:639` | `MINLOCK` per variant | (a) new covers |
| **Ladder** (covers and opens) | $0.05 per 120 s **or** per 10 NDX pts. Every variant (no control cells since 2026-10-09). | `:660,892` | `MINLOCK_CTL` | (a) |
| **Give-up** | 10 pts through the short strike. Max loss 5% (10W) / 7.5% (20W) / 10% (40W) of W. All variants. | `:959` | `GIVEUP=none` | (a) |
| **Re-strike** | An open at its walk cap, unfilled for **10 min**, is cancelled and re-placed next bar. All variants. | `:830` | none | (b) |
| **Floor raise** | On for all variants including armed v7-10. **3:1**, objective **spreadFirst**. Valley-sized condors/flies, one or two strikes wider (`floor-raise.js:52`). Engine defaults: re-plan every 15 min, ≤8/day, ≤2/pass, 2σ band, mid +2 ticks, one working raise at a time, never pushes a locked (≥0) floor below 0. | `:842`; `trader.js:1292` | `FLOOR_RAISE=off`/`sim` | (a) |
| **Stall cover** | **15 min**, 0 pts. Cover → min(break-even, mark+1 tick), only if that raises the ask. | `:868`; `trader.js:3344` | `STALL_COVER=off` | (a) |
| **Late-day guard** | From **15:00 ET**, `keepLocked`. The floor at first check is the reference. If it is ≥0, nothing may take the floor below 0. If it is <0, the guard is inert. | `:874`; `trader.js:891` | `LATE_FLOOR=off` | (a) |
| **Sim-fill realism** | Open fills no earlier than the 2nd look. Cover needs 1 tick through. Fills book at the limit. | `:825` | `SIM_FILL=legacy` | mostly (b) |
| Credit capital trigger | 0.25×W×100 | `:707` | `CREDIT_TRIGGER_XW=0` | (a) |
| Floor-raise stages (fold) | **raise-cap**: past `lossMax`, best available lift, no ratio, every bar (was offsets' must-fix) — all 50 governed. **raise-wing**: on a floor-raise pass that found nothing, the wing planner (ratio 3, budget 10% of peak, upside term) priced at mid + 1 tick/leg — all 80. Flies/condors are on the floor-raise menu. Stand-alone flies, wings and offsets are OFF. | `applyFloorRepairFold`; `trader.js` `raiseFloor`/`buyFloorOffsets`/`convertWings` | `FLOOR_FOLD=off`, `FLOOR_RAISE=off` | (a) |
| Day-loss governor, cover-to-stack, continuous cover, capital recapture, leg uniqueness, open-never-OTM | All variants (`BASE_RUNS`) | `:100-148` | none | (a) |
| **Built but OFF on the live roster** | Floor-raise near-cap mode (`floorRaiseNearCapFrac`), trend side-guard (`floorRaiseTrend`), give-up trend urgency (`giveUpTrend`), ratchet grid, order slip | `trader.js:1285,1362,3324` | n/a | n/a |

**Effective loss caps at HEAD** (lossMax; F = raised to the 1.5×W floor, C = lowered to the $7,500 ceiling):

| | 10W | 20W | 40W | 20W cATM | 40W cATM |
|---|---|---|---|---|---|
| v0 | 2,000 | 4,500 | 6,000 F | 7,000 | 7,500 |
| v1 | 2,000 | 4,500 | 6,000 | 4,500 | 7,500 C |
| v2 | 2,000 | 4,500 | 6,000 F | 4,500 | 7,500 |
| v3 | 2,000 | 3,000 F | 7,500 C | 3,500 | 7,500 |
| v4 | 2,000 | 4,500 | 7,000 | 4,500 | 7,500 C |
| v5 | 2,000 | 4,000 | 7,500 C | 4,500 | 7,500 |
| v6 | 2,000 | 4,500 | 7,500 C | 7,000 | 7,500 C |
| **v7** | **2,000** | 6,500 | 6,000 F | 6,500 | 7,000 |
| v8 | 2,000 | 3,000 F | 6,000 F | 7,000 † | 6,000 F |
| v9 | 2,000 | 4,500 | 7,500 | 6,500 | 7,500 |

† Generic `maxCapFor` cap, untuned. lossTarget is the base $5,000. A cap bounds the projected **book floor** that opens are gated on. It is not a guaranteed max loss.

---

## 4. "Something feels wrong" quick guide

**Where to look:**
- `GET $PROD/health?t=<now>`. CloudFront caches 5xx, so cache-bust. Check `degraded`; `schwabToken.state` (valid / expiring / expired / probe-failed / unverified / missing), `daysLeft`, `ageUnknown`; and `disk.candleRunArchive.writable` and `shipQueue`.
- `GET $PROD/api/v1/candle-spread/status`. Check `mode` (DEV / DISARMED / LIVE-ARMED / TEST-ARMED); `gates.*`; `gates.strategyControl`; `gates.fillSource`; `configProblems`; `tradability`; and per run `control`, `bookReconcile`, `positionReconcile`, `rejectStreaks`, `realOrders`.
- `debug.html` (repo root, reads prod), e.g. `debug.html?variant=v7-10&date=2026-10-08`. Shows the per-decision timeline and mechanism counts.

| Symptom | Check | Flip |
|---|---|---|
| Nothing opening | Decisions `open-skip-governor` (projected floor > lossMax), `open-skip-late` (after 15:00, locked floor), `open-skip-control` (control restrict), `open-skip-ceiling` (no strike in the price band), `open-skip-pending` (an open is already working). Also `tradability` on `/status`. | Usually correct behaviour. `LATE_FLOOR=off` lifts the late gate. Control `resume` lifts a restrict. |
| Cover not placed / not moving | `cover-defer-governor`, `cover-defer-late` (would lower a locked floor after 15:00), `order_control_blocked` (halt). Is the ladder on (`/status` run `ladder`)? | `resume`; `LATE_FLOOR=off` |
| Cover jumped toward the market | `cover-giveup` (10 pts through the short strike) or `cover-stall` (15 min not in the money → break-even) | `GIVEUP=none` / `STALL_COVER=off` |
| Unexpected small debit hedges | `raise` (with cost / lift / ratio / quotedMid / quotedAsk), `raise-wing` (wing stage), `raise-cap` (must-fix past the cap). Refused raises: `raise-blocked-locked`, `raise-blocked-floor`, `raise-blocked-trend`. Bad quote: `raise-badquote`. | `FLOOR_RAISE=off` (or `sim` to spare the armed variant) |
| Engine book ≠ Schwab | `book_reconcile` / `position_reconcile` events with severity `DIVERGENT` or `UNREADABLE` (`expected` = sim/test). `/status` `gates.fillSource` must be `broker` when live. | **WIND DOWN** first, then investigate. Do not re-arm. |
| You edited a price at Schwab | `order_adopted_manual_edit`: adopted, and the engine now works the new id (6d5c823, `order-manager.js:402`). `order_manual_replace_unmatched`: no successor found, so the engine **re-creates its order**. | Nothing. Check that it adopted. |
| Order vanished / rejected | `order_dead` (broker CANCELED / REJECTED / EXPIRED; the cover's pendingCover is cleared, so it gets re-placed); `order_reject_streak` | Investigate the reason in `statusDescription` |
| Control didn't take | `/status` `gates.strategyControl`: `error`, `source:'stale-cache'`, `downgraded[]` (live→paper or clamped), `unknownVariants[]`, `rejected[]`, `expired[]` | Fix the file or env |
| Market data / auth errors | `/health` `schwabToken.state` = `expired` | Renew (below) |
| Variant runs "default" config | `/status` `configProblems` (a name in an env list matches no variant) | Fix the spelling |

**Rules that matter:**
- **Never cancel or edit engine orders at Schwab, except a price edit.** A price edit is adopted (6d5c823). A manual **cancel** clears the engine's pending order and **it re-creates the order** on the next pass. To stop it, use the control page.
- **Token renewal must update BOTH places.** Run `node scripts/renew-schwab-token.js`. It writes `SCHWAB_REFRESH_TOKEN` + `SCHWAB_REFRESH_TOKEN_ISSUED_AT` to local `.env` and restarts local. Then set the **same two vars on EB**, which restarts prod. Verify with `node scripts/check-token-health.js` (checks local and prod).
- **Prefer control over env for emergencies.** Control acts in ≤20 s with no restart. An env change restarts the app, and nothing is managed during the gap.

---

## 5. Not verified / caveats

- **Re-arming mid-session** (changing `CANDLE_SPREAD_ARMED` / `_ARMED_MODE` during RTH): the mode switch is (a), but the variant's sealed record still holds positions booked under the old fill source. Mixing the two was not traced. Treat arming changes as next-session changes.
- The `buildEngineDeps` comment (`index.js:1815-1816`) says the control file can start a second variant paper-trading. The clamp in `strategy-control.js` (`normalise`) refuses that. The code behaviour is what §2 describes.
- Some floor-raise refinements (near-cap 1:1 mode, trend side-guard) are engine capabilities, but the live roster does not set their fields at `b3b0433`. Confirm whether they were meant to be live.
- Restart-gap length on EB and CloudFront header forwarding for `x-control-token` were not measured. The control page sends the token in both the header and the body.
