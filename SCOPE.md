# SCOPE.md — Anomaly log & database schema

This file is the contract for how the importer treats `expenses_export.csv`.
For **every** data problem it: **(1) detects** it, **(2) surfaces** it as an
`import_anomalies` row shown in the app's import report, and **(3) handles** it
with the documented policy below. Nothing is silently guessed; anything that
deletes or changes data is held for human approval.

Run `npm run import:csv` to reproduce the live report
([docs/import_report.sample.txt](./docs/import_report.sample.txt)).

## Severity & approval model

- **info** — a deterministic, lossless normalisation (trim whitespace, strip a
  thousands comma, `DD/MM/YYYY → ISO`). Applied automatically.
- **warning** — a judgement call was made (rounding, FX, dropping a member from
  a split, normalising bad percentages). Applied, logged, and — when it changes
  or removes data — flagged `pending_approval`.
- **error** — the row can't be computed safely; it is **quarantined**
  (excluded from balances) until a human fixes it.

A row contributes to balances only when `expenses.status = 'active'` and
`kind = 'expense'`. Statuses `duplicate`, `quarantined`, `skipped`, and
`pending_approval` are excluded. Settlements always count.

## The anomaly catalogue

Each row links the **CSV row** (1-based, header = row 1), the stable
`anomaly_type`, the policy, and **where in code** it is handled (for the live
trace-through).

| # | CSV row(s) | Problem | `anomaly_type` | Policy / handling | Code |
|---|-----------|---------|----------------|-------------------|------|
| 1 | 5 & 6 | Same dinner ("Dinner at Marina Bites" / "dinner - marina bites") logged twice, identical date/amount/payer | `exact_duplicate` | Keep row 5; mark row 6 `duplicate` (excluded). Flagged for approval; reject restores it. | `importer.js` → `markDuplicates` |
| 2 | 24 & 25 | Same Thalassa dinner, **different** amount (₹2400 vs ₹2450) & payer; note says one is wrong | `conflicting_duplicate` | Don't guess. Hold **both** `pending_approval` (excluded) until a human picks the winner via *resolve*. | `markDuplicates`, `routes/imports.js` resolve |
| 3 | 7 | Amount with thousands separator `"1,200"` | `amount_thousands_separator` | Strip commas → 1200 (info). | `lib/money.js` `parseAmountToMinor` |
| 4 | 29 | Amount padded with spaces `" 1450 "` | `amount_whitespace` | Trim (info). | `parseAmountToMinor` |
| 5 | 10 | Sub-paise precision `899.995` | `amount_sub_minor` | Round half-up to nearest paise → ₹900.00. | `parseAmountToMinor` + `roundHalfUp` |
| 6 | 9, 11, 27 | Name variants `priya`, `Priya S`, `rohan ` (trailing space/case) | `payer_name_variant` / `participant_name_variant` | Normalise to the canonical member (info). | `lib/names.js` `normaliseName`, `NameResolver` |
| 7 | 13 | Missing payer ("can't remember who paid") | `missing_payer` | **Quarantine** — can't know who is owed. Excluded until a payer is set. | `importer.js` payer block |
| 8 | 14 | Settlement logged as expense ("Rohan paid Aisha back", blank `split_type`) | `settlement_logged_as_expense` | Reclassify as a **settlement** Rohan→Aisha (₹5000); no split. Approval-flagged. | `importer.js` transfer detection + `persist` |
| 9 | 38 | Personal transfer ("Sam deposit share", paid to Aisha only, note "deposit") | `settlement_logged_as_expense` | Same: reclassify as settlement Sam→Aisha (₹15000), not a shared expense. | same |
| 10 | 15, 32 | Percentages sum to **110%**, not 100 | `percentage_sum_not_100` | Normalise proportionally (each `pct / total`) so shares stay exact; flag. | `splitEngine.js` `computePercentage` |
| 11 | 16, 28–33, 27 | Mixed date formats — `DD/MM/YYYY`, `Mar 14` | `date_normalised` | Slash format is **DD/MM** (proven by days > 12); normalise to ISO. `Mar 14` → year inferred 2026 (warning). | `lib/dates.js` `parseDate` |
| 12 | 34 | Ambiguous/out-of-place date `04/05/2026` ("Apr 5 or May 4?") | `ambiguous_date` | Parse as DD/MM → 2026-05-04, but it sits **out of chronological order**, so flag it for confirmation (approval). | `importer.js` `flagOutOfOrderDates` |
| 13 | 20, 21, 23, 26 | USD amounts treated as rupees | `currency_converted` | Convert USD→INR at a fixed documented rate (83.0); store original + converted + rate. | `lib/fx.js` `convertMinor` |
| 14 | 28 | Missing currency ("forgot to set currency") | `missing_currency` | Default to group base (INR); flag for approval. | `importer.js` currency block |
| 15 | 23 | Non-member in split ("Dev's friend Kabir") | `unknown_participant` | Create a **guest** member "Kabir" so the 5-way split is correct; guests carry balances but have no enforced window. Flagged. | `importer.js` `ensureGuest`, `roster.js` |
| 16 | 26 | Negative amount `-30 USD` (parasailing refund) | `negative_amount` | Treat as a **refund**, not an error: keep negative amount, distribute negative shares. | `importer.js` amount block, `allocateByWeights` (sign-safe) |
| 17 | 31 | Zero amount ("counted twice earlier - fixing later") | `zero_amount` | **Skip** — no financial effect; excluded from balances. Flagged. | `importer.js` amount block |
| 18 | 36 | Member who left still in a split (Meera on 2026-04-02; she left 2026-03-31) | `inactive_member_in_split` | Drop Meera from the split, re-split among active members, flag. This is Sam's & Meera's requirement in action. | `importer.js` `buildParticipants`, `roster.js` `isActiveOn` |
| 19 | 42 | Contradiction: `split_type=equal` but `split_details` present | `split_details_ignored` | Honour the declared `split_type` (equal); ignore the stray details; flag (info). | `importer.js` equal branch |
| 20 | 22, 35 | `share` split type with weights | _(supported, not an anomaly)_ | Weighted allocation via largest-remainder. | `splitEngine.js` `computeShares` |

That is **20** distinct handled issues across the file (the assignment promised
"at least 12").

### Edge cases & invariants worth knowing

- **Split totals are exact.** Every expense's per-member shares sum back to the
  expense amount to the paise (largest-remainder method in `money.js`). No paise
  is ever lost or invented, including for refunds (negative totals).
- **Balances sum to zero** across all members (residents + guests). Verified in
  testing after import: Σ net = 0.
- **A failed import writes nothing.** The whole import runs in one DB
  transaction (`withTransaction`); any error rolls back — no half-imported state.
- **Re-import is safe & auditable.** Each import is a new `import_runs` row; the
  CSV is ingested exactly as provided (no hand-editing).

## Database schema

Full DDL: [`server/db/schema.sql`](./server/db/schema.sql). Design rules:

1. **Money = integer minor units (paise).** No floats are ever stored, so split
   arithmetic is exact.
2. **Original + converted currency are both kept** (`original_amount_minor`,
   `original_currency`, `fx_rate`, `amount_minor`) so any converted value traces
   back to the source row (Priya's & Rohan's requirements).
3. **Membership is time-bounded** (`members.joined_on/left_on`,
   `member_type` resident|guest); the importer enforces it.
4. **Every transform is auditable** via `import_anomalies` (type, severity,
   message, action, approval status, the raw CSV row as JSONB).

### Tables

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | login accounts | `email`, `password_hash` |
| `groups` | a shared-expense group | `base_currency` |
| `group_users` | which users can access a group | `(group_id, user_id, role)` |
| `members` | participants in a group's expenses | `member_type`, `joined_on`, `left_on` |
| `member_aliases` | raw CSV name → canonical member | `raw_name`, `member_id` |
| `expenses` | expense/settlement header | `amount_minor`, `original_*`, `fx_rate`, `split_type`, `kind`, `status`, `source_row` |
| `expense_splits` | per-member owed share | `share_minor` (Σ = `amount_minor`) |
| `settlements` | payments between members | `from_member`, `to_member`, `amount_minor` |
| `import_runs` | one per CSV import | `total_rows`, `imported_rows`, `anomaly_count` |
| `import_anomalies` | the audit log / approval queue | `anomaly_type`, `severity`, `action`, `status`, `raw_row` |

### Relationships

```
users ──< group_users >── groups ──< members ──< member_aliases
                              │           │
                              │           └──< expense_splits >── expenses ──> import_runs
                              │                                      │
                              └─────────────< settlements <──────────┘
                                       import_anomalies >── import_runs
```
