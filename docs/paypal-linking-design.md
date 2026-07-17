# PayPal ↔ bank auto-linking — what the data allows (design proposal)

Status: APPROVED + PP1 SHIPPED 2026-07-17 (any funding account — ING was only the example; count-once-on-the-PayPal-side confirmed) (user question: "does the PayPal account
from GoCardless have a bank account number, and can the algorithm
auto-label ING→PayPal charges as transfers with the PayPal account as
counterparty?").

## What identifiers actually exist

- **The PayPal feed (GoCardless `PAYPAL_PPLXLULL`)** usually exposes NO
  user-specific IBAN — the account is identified by a masked id/email.
  (Some PayPal Europe accounts have a virtual `LU…` IBAN, but GC does
  not reliably return it.)
- **The bank side (your ING debit for a PayPal charge)** carries
  PayPal's SHARED collection IBAN (the same `LU…` for every PayPal
  customer), the creditor name `PayPal (Europe) S.a.r.l. et Cie`, a
  per-user **mandate reference** (stable per billing agreement), and
  remittance info that usually embeds the merchant name.

So: **no, there is no clean IBAN pair** like with your own two bank
accounts — the counterparty IBAN on the ING side belongs to PayPal the
company, not to your PayPal account. Certainty by ids alone is not
available. But the signals are strong enough for a high-confidence
match:

## Proposed mechanism (PP1)

1. **Recognize PayPal-funding debits** on any bank account: creditor
   IBAN in the known PayPal collection set OR creditor name matching
   `paypal` (case-insensitive). This classification alone is
   near-certain.
2. **Pair-match against the PayPal feed** when one is connected: a
   PayPal transaction with the same amount within ±3 days whose
   merchant appears (fuzzy, merchantKey) in the ING remittance text →
   auto-link the ING debit as `transfer` with
   `linkedAccountId = <PayPal account>`, review skipped. The spend
   itself is then counted ONCE, on the PayPal side, with the real
   merchant — that also kills the double-counting a PayPal+bank pair
   otherwise creates.
3. **Unpaired PayPal-pattern debits** (no PayPal feed connected, or no
   match): the review card pre-suggests `transfer` + the PayPal
   account (if any) exactly like the own-IBAN counterparty rule, but
   keeps review on — one tap to confirm.
4. The stable **mandate reference** is remembered per link (merchant
   memory style), so the second charge of the same billing agreement
   matches even when the remittance is unhelpful.

This mirrors the approved credit-card ruling (credit → transfer) —
same UX, fuzzier evidence, hence the review-gated fallback rung.

## Review questions

1. OK that pair-matched ING→PayPal debits skip review (rung 2), while
   pattern-only hits stay review-gated (rung 3)?
2. When both feeds are connected, the PayPal-side transaction carries
   the category and the bank-side debit becomes a transfer — confirm
   this "count once, on the PayPal side" rule.
