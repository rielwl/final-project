# Validation rules

Every rule is a pure function `(PaymentContext) -> list[RuleViolation]`. The
engine (`app/engine.py`) runs all rule groups, collects violations, and declines
if any violation has severity `BLOCK`.

## Rule catalogue

| Code | Severity | Module | Meaning |
|---|---|---|---|
| `LIMIT_PER_PAYMENT` | BLOCK | `app/rules/limits.py` | Amount exceeds the per-payment ceiling for the client |
| `LIMIT_DAILY` | BLOCK | `app/rules/limits.py` | Rolling 24h total would be exceeded |
| `INSUFFICIENT_FUNDS` | BLOCK | `app/rules/limits.py` | Ledger balance below amount (queried live) |
| `SANCTIONS_HIT` | BLOCK | `app/rules/sanctions.py` | Counterparty matched the watchlist |
| `SANCTIONS_FUZZY` | REVIEW | `app/rules/sanctions.py` | Near-match, routed to manual review |
| `CURRENCY_UNSUPPORTED` | BLOCK | `app/rules/currency.py` | Currency not enabled for the client |
| `CURRENCY_CUTOFF` | BLOCK | `app/rules/currency.py` | Submitted after the settlement cut-off |

## Ordering and short-circuiting

Rules are evaluated in a fixed order (sanctions, currency, limits) so that a
declined payment reports the most compliance-relevant reason first. Evaluation
does **not** short-circuit: all groups run so the response lists every reason,
which is what the audit trail requires.

## Adding a rule

1. Add the pure function to the right module in `app/rules/`.
2. Register it in `RULE_GROUPS` in `app/engine.py`.
3. Add the code to the catalogue above and to `tests/test_engine.py`.
