# Coffee bar: quarterly numbers (one page)

Q3 review · Store #12 (Riverside) · POS export 2026-07-01 → 09-30, loyalty app logs 2026-07-15 → 09-30 · The kiosk channel is ~40 orders/day and is ignored.

## 1. What each drink costs us today (all channels)

| Drink | Orders / day | Make time p50 | p90 | p99 |
|---|---|---|---|---|
| `espresso` | 1.2 K | 49 s | 63 s | 127 s |
| `latte` | 3.8 K | 55 s | 97 s | 152 s |
| `cold-brew` (≤ 20 oz) | 315 | 53 s | 66 s | 450 s |
| `pour-over` | 154 | 69 s | — | 429 s |

One grinder cycle ≈ 27 s (`espresso` bar p50). `cold-brew` time scales with batch size: 1–2 cup pours ~53 s, 20-cup carafes ~380 s. `cold-brew` max in-window 29.0 min = the steeping hard limit.

## 2. The catering desk's share of orders (7 days)

| Team | espresso | pour-over | cold-brew | latte | Path |
|---|---|---|---|---|---|
| OfficeMornings | 498 | 43,065 | 33,545 | 1,935 | pour-over → cold-brew |
| WeekendMarkets | 33,669 | 2,676 | 776 | 33,549 | espresso → latte (1:1) |
| CampusEvents | 6,952 | 3,391 | 920 | 6,164 | mostly espresso → latte |
| **Catering total** | **41.5 K** | **90.2 K** | **35.3 K** | **41.7 K** | |
| Store total | 266.6 M | 10.8 M | 22.0 M | 411.9 M | |
| Catering share | 0.016 % | 0.84 % | **0.16 %** | 0.010 % | |

19 accounts order `cold-brew`; the top three (TeeterTotter 1.85 K/day, RackInstaller 0.91 K, GutCheck 0.66 K) are 93 % of it.

## 3. Cost of each option

| Option | Extra trips / order (catering) | Added wait | Who pays |
|---|---|---|---|
| A. Catering asks `espresso` bar per cup (client side) | +20–30 | Catering: +1.3 min sequential (25 × 52 s) or ~+100 s in parallel on a ~170 s chain. Store: +100–150 orders/day = **+0.3–0.4 % on espresso** (worst case +1 %) | Catering's wait; bar capacity is not the constraint |
| B. Fold into `latte` / `cold-brew`, sequential | 0 | `cold-brew` **+400–600 s** at 20 cups (catering p50 73 → 500–700 s, 7–9×) | **All 19 cold-brew accounts + all `latte` customers (62 K orders/day)** |
| C. Fold into `latte` / `cold-brew`, parallel | 0 | **+60–80 s p50, +100–150 s p99** (catering p50 73 → ~145 s, 2×; p99 372 → ~500 s); 20× grinder amplification (~doubles today's 38 K/day grinder cycles) | Same — every customer, every order |
| B′. Opt-in `extraShot=true` on `cold-brew` | 0 | +60–100 s only when set | Opt-in customers; still couples a grinder cycle into the pour |

## 4. Evidence (raw POS rows, `catering-path-evidence.md`)

- OfficeMornings alternates `pour-over` → `cold-brew` with no `espresso` call in between.
- WeekendMarkets is a strict `espresso` → `latte` pair, one for one.
- CampusEvents is 88 % `espresso` → `latte`, the remainder single `latte` orders.

## 5. Position

The extra shot stays in `espresso`, full stop.

- Zero extra trips for the two teams already on the `espresso` path.
- +20–30 trips per order for OfficeMornings only, at +0.3–0.4 % bar load.
- No wait added for the other 19 `cold-brew` accounts or the 62 K daily `latte` customers.

## 6. Caveats

- Make-time percentiles are bar-side; customer-perceived wait adds queue time.
- Kiosk orders are excluded (≈ 40/day).
- Seven-day catering shares move ±0.02 pp week to week.
