# Investments — design

Status: **I1–I3 built 2026-07-10** — manual holdings/lots, delayed
quotes (Yahoo + CoinGecko, USD→EUR bridge), symbol search, DEGIRO CSV
import, home block. Rulings: both import AND (later, experimental)
broker logins; stocks+crypto; per space; delayed prices fine. I4
(experimental DEGIRO session login) stays a later, clearly-labelled
phase; other Dutch broker CSVs become sibling parsers on request.

## The honest landscape first

- **DEGIRO has no official API.** Community libraries (degiro-connector
  and friends) reverse-engineer the web trader: username/password +
  2FA, sessions that expire fast, bot detection, and a ToS that
  forbids automation. It breaks several times a year. Treating it like
  our bank feed would make munni's most fragile feature.
- **What DEGIRO does offer, officially and stably: CSV/statement
  exports.** Portfolio (holdings + values) and Transactions (buys,
  sells, fees, dividends) export in one tap. This is our CAMT-053
  moment: file import made DEGIRO-proof, entirely on-device.
- **Prices are the easy part.** Free delayed quote feeds exist for
  stocks/ETFs (Yahoo Finance's unofficial endpoints — stable for
  years) and crypto (CoinGecko, free tier). 15-minute-delayed prices
  are perfectly fine for a personal net-worth view; munni is not a
  trading terminal.

**Recommendation: manual + import first, live prices on top, broker
scraping never (or last).** Same philosophy as bank data: files and
your own entries are the reliable spine; automation is decoration.

## What the feature is

A **Portfolio** view answering four questions:

1. **What do I own?** Holdings: name, ticker/ISIN, quantity, asset
   class (stock / ETF / crypto / cash-at-broker / other).
2. **What is it worth right now?** Quantity × latest price, summed —
   plus per-holding and total **day change**.
3. **Am I winning?** Cost basis per holding (average buy price from
   lots) → unrealized gain/loss, absolute and %. Realized gains and
   dividends listed from imported/entered lots.
4. **Is my mix sane?** Allocation donut by asset class and by holding
   (concentration warning when one position > 40%).

The existing plumbing already meets it halfway: `brokerage` account
type exists, the overview's *Invested* bucket already counts transfers
to brokerage accounts, and the home landing zone takes a new block.
The portfolio makes the *contents* of those brokerage accounts real.

## Data model (synced, per space — same laws as everything else)

```
holding {
  id, spaceId,
  accountId?,               // the brokerage account it lives in
  name, symbol?, isin?,
  assetClass: 'stock' | 'etf' | 'crypto' | 'cash' | 'other',
  currency,
  priceSource?: 'yahoo' | 'coingecko' | 'manual',
  manualPriceCents?,        // for unlisted/other assets
}
lot {                       // buys/sells/dividends — the audit trail
  id, spaceId, holdingId,
  kind: 'buy' | 'sell' | 'dividend' | 'fee',
  date, quantity?, priceCents?, totalCents,
}
```

Derived (pure domain math, like goals/debts): position quantity =
Σ lots; average cost = Σ(buy totals)/Σ(buy qty); market value =
qty × price; day/total change; allocation percentages.

**Prices are NOT synced data.** A device-local price cache table
(symbol → {price, dayChangePct, at}) refreshed at most every 15
minutes while the portfolio is open. Server involvement: one thin
`/quotes?symbols=…` pass-through (CORS again), stateless, cached
60s server-side to be a polite API citizen. Demo/offline identities:
manual prices only, zero network — the law stands.

## UX

1. **Portfolio screen** (Settings → This space → Portfolio + home
   block): total value hero with day change, allocation donut,
   holdings list (value, day %, total gain colored). Tap a holding →
   detail: lots history, add buy/sell/dividend, price source.
2. **Add holding**: search-as-you-type against the quote proxy
   (name/ticker), or fully manual for unlisted assets.
3. **DEGIRO import**: file picker on the portfolio screen accepting
   DEGIRO's Portfolio.csv and Transactions.csv — parsed on-device
   (CAMT-style), mapped to holdings + lots, idempotent via
   deterministic ids (re-import is a no-op). Other brokers' CSVs
   become adapters later (same pattern as store receipts).
4. **Home block**: total value + day change sparkline; hidden until a
   holding exists.
5. **Overview tie-in**: the *Invested* tile can deep-link here.

## Rollout

- **I1** — entities + manual holdings/lots + portfolio math + screen
  + home block (fully offline-capable, no price feeds yet).
- **I2** — quote pass-through + price cache + day change + symbol
  search; concentration warning.
- **I3** — DEGIRO CSV import (both files), dividend/fee history.
- **I4 (only if you still want it)** — community DEGIRO session login
  for automatic position sync, device-only credentials like store
  connections, clearly labelled experimental.

## Open questions

1. Is **manual + CSV import first** the right call, or do you want the
   experimental DEGIRO login pushed earlier despite the fragility?
2. Which asset classes do you actually hold today (stocks/ETFs?
   crypto?) — determines whether CoinGecko lands in I2 or later.
3. Portfolio per space (like everything else) — or is investing
   personal enough that it should live only in personal spaces?
4. Delayed (15-min) prices are fine? Real-time needs paid feeds — my
   advice: no.
