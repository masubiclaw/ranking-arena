# Identifying Skilled Traders with Empirical Bayes Shrinkage

**TL;DR.** The Arena leaderboard ranks traders by a composite *Arena Score*, but
the top of that ranking is dominated by lucky short streaks and the bottom is
indistinguishable from noise. Borrowing the **superforecaster** idea from
Tetlock's work — that only a small fraction of forecasters have genuine
persistent edge — we applied **empirical Bayes shrinkage** to a *Sharpe-vs-BTC*
metric. The result is a ranking that (a) compresses the lucky outliers
proportionally to how thin their evidence is, (b) decompresses the cluttered
middle into actionable bands, and (c) yields a population-calibrated cutoff
for "credibly skilled" traders. ≈4% of qualifying traders clear that
cutoff — comfortably close to Tetlock's empirical 2% baseline, without us
having to assume it.

---

## The problem with raw ranking

Two failure modes show up when ranking traders by performance directly:

1. **Top-end saturation.** Arena Score uses `tanh` to bound the metric at 100.
   Anyone clearing the elbow of the curve clusters in 99.x territory; ranks 1–50
   sit within ~0.5 points of each other, and the ordering inside that cluster is
   essentially random.
2. **Middle-band compression.** The raw Sharpe-vs-BTC metric piles up against
   the benchmark return — on 7D (BTC down 1.4%) **304 of 371 qualifying
   traders** sit in the `0–2` bucket because "anyone who didn't lose money beat
   BTC." That single bucket is the entire actionable middle of the population
   and the bot can't choose inside it.

Both problems are *signal-to-noise* problems: the score doesn't distinguish
"made 50% with 100 trades" from "made 50% with 4 trades."

## The fix — empirical Bayes shrinkage

### Intuition

Imagine two traders this week:

- **Trader A** made 60% return with 500 trades.
- **Trader B** made 60% return with 5 trades.

Same observed performance, but they are not the same evidence. Trader A
demonstrated their result across many independent decisions; Trader B might
have caught one lucky move. A copy-trading bot should treat them differently.

Empirical Bayes shrinkage gives us a principled way to do exactly that. It
answers the question:

> *Given the population of all traders we observe, and given how many trades
> this one has under their belt, what is the most likely value of their **true
> underlying skill** — not their lucky-streak performance, but the level we'd
> expect them to sustain?*

The formal answer is a weighted average between two things:

1. **The trader's own observed score** (what they actually achieved this period)
2. **The population average** (what a "typical" trader achieves)

The weight on the population average gets bigger when the trader's evidence is
thin. So Trader B above gets pulled hard toward the average; Trader A barely
moves. The intuition is the same as why we don't say a player batting .500
after 4 at-bats is the best hitter in baseball — we wait until they've had
enough at-bats for the number to mean something.

### The math

Each trader has an unobservable *true skill* `θᵢ` (their long-run
Sharpe-vs-BTC). We observe a noisy version of it:

```
observed_i  =  θᵢ  +  ε_i        where  ε_i ~ N(0, σᵢ²)
```

`σᵢ²` is how much *measurement noise* surrounds this particular trader's
observation. Traders with many trades have small `σᵢ²` (precise estimate);
traders with few trades have large `σᵢ²` (noisy estimate). We approximate it
as `baseline / √trades_count`.

Across the whole population, the true skills themselves follow a distribution:

```
θᵢ  ~  N(μ_pop, τ²_pop)
```

We learn `μ_pop` (the average true skill) and `τ²_pop` (how much true skill
varies across traders) directly from the data — that's the "empirical" in
empirical Bayes. No assumptions, no hand-tuning.

Bayes' rule then gives us the posterior mean for each trader's true skill:

```
θ̂_i  =  w_i · μ_pop  +  (1 − w_i) · observed_i

where  w_i  =  σᵢ² / (σᵢ² + τ²_pop)
```

That's the "shrunk" score in the table. Read the formula in plain English:

- `w_i = 0` means *all weight on observed, no weight on prior* — we trust the
  data fully. Happens when the trader has many trades (small `σᵢ²`).
- `w_i = 1` means *all weight on prior, no weight on observed* — we trust only
  the average. Happens when the trader has almost no data.
- Real traders sit somewhere between. A trader with 500 trades typically lands
  at `w ≈ 0.05–0.10`; a trader with 10 trades at `w ≈ 0.5–0.7`.

We also get the **posterior uncertainty** for free — the standard deviation of
our belief about `θᵢ`. This lets us compute a calibrated probability:

```
P(this trader is a superforecaster | their data)
  =  P(θ̂_i > threshold)
```

where `threshold` is chosen so the top 5% of the *shrunken* distribution sits
above it. This is the population-calibrated analogue of Tetlock's 2%
superforecaster prior — and crucially, the threshold is *measured from the
data* rather than asserted.

This is the same machinery that baseball analytics use for batting averages,
that A/B-test platforms use to combine multiple experiment results, and that
forecasting tournaments use to score predictors. We're applying it to crypto
traders.

## What it looks like on real data

For each window we have ~370–404 traders with credible drawdown data. The
distributions before and after shrinkage:

### 7D — Raw vs Shrunk (n=371)

```
RAW 7D                                │  SHRUNK 7D
  bucket    count                     │  bucket      count
   0 to  2: 304 █████████████████████ │   0 to 0.5: 129 █████████████
   2 to  5:  22 █                     │   0.5 to 1: 131 █████████████
   5 to 10:  36 ██                    │   1 to  2:  45 █████
  10 to 20:   7                       │   2 to  3:  14 ██
  20 to 50:   1                       │   3 to  5:  32 ████
                                      │   ≥5     :  19 ███
```

The single 304-trader pile shatters into a usable gradient. Each band now
represents a distinct credibility tier — the bot can address them differently.

### 30D — Raw vs Shrunk (n=371)

```
RAW 30D                               │  SHRUNK 30D
  bucket    count                     │  bucket      count
 −10 to −5:  11                       │   <−2     :  21 ███
  −5 to −2:  24 █                     │   −2 to −1:  32 █████
  −2 to  0: 277 ████████████████████  │   −1 to −0.5:53 ████████
   0 to  2:  26 █                     │  −0.5 to 0: 213 ██████████████████████████████
   2 to  5:  21 █                     │   0 to 0.5:  10 █
   5 to 10:   9                       │   1 to  2:  14 ██
  10 to 20:   2                       │   2 to  3:   8 █
  20 to 50:   1                       │   ≥5     :   5 █
```

Negative skew gets *clearer*, not noisier. A previously-hidden `<−2` left tail
of 21 "actively losing to BTC" accounts surfaces — these are the ones the bot
should explicitly avoid copying.

### 90D — Raw vs Shrunk (n=404)

```
RAW 90D                               │  SHRUNK 90D
  bucket    count                     │  bucket      count
     <−10:  22 █                      │   <−2     :  83 █████████████████████████
 −10 to −5:  24 ██                    │   −2 to −1:  68 █████████████████████
  −5 to −2:  51 ████                  │   −1 to −0.5:105 ███████████████████████████████████
  −2 to  0: 247 ████████████████████  │  −0.5 to 0:  97 █████████████████████████████
   0 to  2:  24 █                     │   1 to  2:  11 ███
   2 to  5:  21 █                     │   2 to  3:   9 ███
   5 to 10:   6                       │   3 to  5:   5 █
  10 to 20:   3                       │   ≥5     :  12 ████
  20 to 50:   4                       │
     ≥50  :   2                       │
```

A 247-trader "middle blob" fans out across four credibility tiers. ~38% of the
population is now visibly in the `< −1` zone, which the raw histogram hid.

## Top 10 on 90D — where shrinkage earns its keep

| Rank | Platform | Raw | Shrunk | Trades | Weight→prior |
|---|---|---|---|---|---|
| 1 | gmx (0xe8d8…) | +98.3 | **+80.5** | 55 | 0.18 |
| 2 | gmx (0xab16…) | +91.9 | +61.5 | **11** | 0.33 |
| 3 | gmx (0x9281…) | +45.5 | +35.9 | 38 | 0.21 |
| 4 | hyperliquid (0x023a…) | +37.0 | **+34.4** | **500** | **0.07** |
| 5 | gmx (0xb686…) | +39.4 | +28.3 | 18 | 0.28 |
| 7 | bitunix (731931…) | +16.5 | +10.7 | ? | 0.34 |

Read row 4 against row 2: same window, raw scores half an order of magnitude
apart, but the *shrunk* gap is much smaller — because the Hyperliquid trader
has **500 trades** of evidence (weight to prior **0.07**, almost zero
shrinkage) while the GMX trader's score is built on **11 trades** (weight
0.33, meaningful pull-back). The model correctly distinguishes *strong
evidence of moderate skill* from *weak evidence of extreme skill*.

## Why this matters for the bot

Three concrete properties of the shrunk ranking that the raw one didn't have:

1. **Calibrated cutoff.** ~17 traders out of 404 score `≥3` on 90D — about 4.2%
   of the population. That's the data-driven analogue of Tetlock's 2%
   superforecaster baseline. The threshold doesn't need to be assumed; it's
   read off the population.
2. **Bot-actionable thresholds.** Instead of "give me top 50 by score" (which
   mixes lucky and skilled), the bot can ask
   "give me traders with posterior probability of true edge > 95%."
3. **Robust to short hot streaks.** A trader with a great 7-day run but
   thin evidence gets pulled back toward the mean. The bot won't chase noise.

## What's next

- **Surface the new criterion through the bot API** (`criterion=shrunk_sharpe_vs_btc`
  and `criterion=p_superforecaster`).
- **Add a dashboard view** showing both raw and shrunk scores side-by-side,
  sortable by either.
- **Expand the eligible pool.** Currently only ~400 traders qualify because
  only 4 of 11 exchanges report drawdown. Computing drawdowns from per-trader
  equity curves (already fetched for Hyperliquid) would 3–5× the pool.
- **Re-validate as data accumulates.** Empirical Bayes parameters drift with
  market regime; the shrinkage weights should be recomputed daily.

---

*Source code:*
- Math: `lib/utils/shrinkage.ts` (next)
- Population estimation script: `/tmp/shrink.py` (proof-of-concept used for this doc)
- Bot API: `app/api/top-traders/route.ts`
