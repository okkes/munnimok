# CSV export — design (PLAN, awaiting approval)

Status: proposal 2026-07-15 (shortlist #3). Small trust feature: munni
can read your banks, so it must also let you leave. Fills the existing
`settings.exportData` placeholder. Fully client-side — nothing is
uploaded anywhere.

## Entry point

Global settings → "Export data" row → a sheet with:

1. **Scope**: current space (default) or all spaces
2. **Date range**: this period / this year / all / custom from–to
3. **Format**: CSV (delimiter auto-chosen: `;` for NL/TR locales so
   Excel opens it right, `,` for EN — overridable), or **JSON backup**
   (everything, machine-readable, for re-import someday)
4. Export button → Blob download,
   `munni-{space}-{from}-{to}.csv`

## CSV shape (RFC 4180, UTF-8 with BOM so Excel reads €-signs)

One row per transaction, splits expanded to one row per split part
(marked in a `split` column):

| column | source |
|---|---|
| date, time | tx |
| account | account name |
| merchant, description | cleaned (`cleanBankText`) |
| amount, currency | signed decimal, raw |
| net_amount | after reimbursements (both directions) |
| category, main_category | localized names at export time |
| type | tx type |
| status | reviewed / unreviewed / pending |
| notes | tx |
| counterparty_iban | when present |
| tags: recurring, event | linked names when present |

Deliberately NOT exported: internal ids by default (a "technical
columns" toggle adds tx id + account id for power users), store
receipt line items (own export later if wanted).

## Domain

`domain/exportCsv.ts`: pure `toCsvRows(txs, accounts, catalog, t)` +
`serializeCsv(rows, delimiter)` — unit-tested including quoting,
delimiter, BOM, split expansion, net amounts.

## Impacted screens (cascade rule — pick what's in)

1. Global settings: Export data row becomes real (sheet above)
2. i18n EN/NL/TR + guide section + what's-new entry
3. (optional) per-event export button on the event detail —
   "export this trip" is a natural micro-use

Effort: well under one arc. JSON backup variant adds ~a third.
