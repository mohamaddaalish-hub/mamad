# EUR/USD M1 Historical Data — 2020 to Present

| Field | Value |
| --- | --- |
| Symbol | EURUSD |
| Instrument | EUR/USD |
| Timeframe | M1 (1 minute) |
| Start | 2020-01-01 |
| End | 2026-09-13 (download date) |
| Timezone | UTC (UTC for every row, no DST, no mixing) |
| Source | Dukascopy Bank SA public historical data feed (https://datafeed.dukascopy.com/datafeed/EURUSD/<YYYY>/<MM-1>/<DD>/BID_candles_min_1.bi5) - EURUSD BID 1-minute candles |
| CSV | [`EURUSD_M1_2020_TO_PRESENT.csv`](EURUSD_M1_2020_TO_PRESENT.csv) |

## Files

| File | Description |
| --- | --- |
| `EURUSD_M1_2020_TO_PRESENT.csv` | Complete cleaned M1 OHLCV history, 2020-01-01 → download date (one file, UTF-8, comma delimited, UTC). |
| `README.md` | This file — provenance + data-quality report. |

## CSV schema

```
timestamp,open,high,low,close,volume
2020-01-02 00:00:00,1.12142,1.12151,1.12138,1.12147,1.23
```

* `timestamp` — start of the 1-minute candle, **UTC**, formatted `YYYY-MM-DD HH:MM:SS`.
* `open` / `high` / `low` / `close` — source **BID** prices, 5 decimal places (Dukascopy EURUSD precision), never modified.
* `volume` — Dukascopy BID-side tick volume for the minute, copied verbatim from the float32 volume field of the source bi5 candle record (Dukascopy documents tick/candle volume in millions of base-currency units). No conversion, scaling or synthesis was applied. It is feed volume, not exchange/central-limit-order-book volume.
* Encoding UTF-8, `,` delimiter, LF line endings, header row included, no comments or
  metadata lines inside the CSV.

## Data-quality report

| Metric | Value |
| --- | --- |
| Actual first timestamp (UTC) | 2020-01-01 00:00:00 |
| Actual last timestamp (UTC) | 2026-09-11 23:59:00 |
| Total candles | 3,016,800 |
| Raw rows parsed from source | 3,016,800 |
| Duplicate rows removed | 0 |
| Malformed rows removed | 0 |
| Invalid candles removed (OHLC rule violations) | 0 |
| Normal weekend / market-closure gaps | 350 |
| Abnormal gaps | 0 |
| Missing minutes inside the covered range | 505,440 |
| Calendar days requested | 2,448 |
| Final CSV size | 165.4 MiB (173,392,147 bytes) |
| Git LFS used | **Yes** |
| SHA-256 of CSV | `bba91b2d9f588c65b9721aa85611392a208a63dbf999b15df207bbc660f0de4b` |

## Cleaning / validation applied

1. All source files (daily `BID_candles_min_1.bi5`) downloaded for every calendar day from
   2020-01-01 to 2026-09-13 and merged.
2. Rows sorted chronologically by UTC timestamp.
3. Exact duplicate timestamps removed (first occurrence kept).
4. Malformed rows removed (non-finite / non-positive prices, negative or non-finite volume).
5. Every candle validated: `high >= open`, `high >= close`, `high >= low`,
   `low <= open`, `low <= close`, all values numeric and inside a sane EUR/USD range.
   Violating rows were removed and counted above; **no candle was ever modified,
   interpolated, synthesized or sampled**.
6. Genuine market gaps (weekends, 24–26 December, New Year) are preserved as-is —
   they are *normal market closures*, not missing data.

## Gaps

* **Normal market-closure gaps:** 350 (Friday-evening →
  Sunday-evening weekend closures and year-end holidays).
* **Abnormal gaps:** 0 — intervals with no candles that fall outside
  the weekend / holiday windows (typically minutes with no tick at all, i.e. no bid change,
  plus any source-side outage).

Largest abnormal gaps (UTC, timestamps only — no price data):

| Gap start | Gap end | Missing minutes |
| --- | --- | --- |
| _none_ | | |

## Calendar days with no source file

None (only Saturdays returned no file, which is expected).

## Notes

* Prices are **BID** prices, which is the standard convention for retail FX OHLC history.
  The ask side is not included; spread therefore has to be modelled separately.
* Timestamps are UTC. Dukascopy's own feed timestamps are UTC, so no conversion was applied.
* `.gitignore` in this repository ignores `/data/` and `*.csv`; the dataset was therefore
  added with `git add -f` so that no existing project file had to be modified.
* Nothing was fabricated: where the source has no data, the CSV simply has no row.
