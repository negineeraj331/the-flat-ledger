# AI_USAGE.md

## Tools used

- **Claude Code** (Anthropic CLI), model **Opus 4.8** — primary pair-programming
  collaborator: scaffolding, SQL, the import pipeline, the React UI, tests, and
  these docs.

I remain the engineer of record. Every file was reviewed; the cases below are
places where the AI's first answer was wrong and I changed it.

## How I directed the work

I gave the AI the assignment PDF and the CSV and had it first **catalogue the
anomalies before writing code**, so the data model would be driven by the real
problems. I then drove the build in stages (schema → money/date/name libs →
import engine → balances → API → UI → docs), reviewing and committing at each
stage rather than accepting one big dump.

### Representative prompts

- "Read the CSV and list every deliberate data problem with the row number and a
  proposed handling policy, before writing any code."
- "Money must be exact. Implement integer-paise parsing that tolerates `1,200`,
  ` 1450 `, and `899.995`, plus a largest-remainder split allocator whose shares
  always sum to the total — including negative (refund) totals."
- "Membership is time-bounded. A resident must not appear in a split outside
  `[joined_on, left_on]`; guests like Dev/Kabir have no enforced window. Show me
  where this is enforced for the live trace-through."
- "Duplicates: handle exact duplicates differently from conflicting ones. Never
  silently pick a winner when amount/payer disagree."
- "Wire the Express app so the exact same `createApp()` runs locally and as a
  Vercel serverless function."

## Three concrete cases where the AI was wrong

### 1. Over-flagging "ambiguous" dates

**What it produced:** the first date logic flagged *every* `DD/MM/YYYY` row where
both day and month were ≤ 12 as `ambiguous_date`. The import report then showed
two ambiguous dates — including **row 35 (`2026-04-01`)**, which is a perfectly
normal date.

**How I caught it:** I read the generated import report and queried the anomalies
table:
```sql
SELECT source_row, message FROM import_anomalies WHERE anomaly_type='ambiguous_date';
```
Two rows came back where I expected one. Row 35 being flagged made no sense — and
the logic contradicted the fact that we had *already determined* the file uses
DD/MM (because rows like `15/03` have day > 12).

**What I changed:** I removed the "both ≤ 12" rule and replaced it with
`flagOutOfOrderDates` — a chronological-order pass that flags a date only when it
is a strict outlier between two otherwise-consistent neighbours. This isolates the
one true offender, **row 34 (`04/05/2026`)**, and stops blaming its neighbour.
(See DECISIONS.md §8.)

### 2. Clearing splits on duplicate rows broke the approval flow

**What it produced:** when marking duplicates, the AI set `r.splits = []` on the
dropped/conflicting rows. That looked harmless, but it meant a rejected duplicate
(Meera says "that wasn't a duplicate") couldn't be restored — its per-member
shares were gone, and reactivating it would put a zero-split expense into the
books.

**How I caught it:** while designing the approve/**reject** endpoint I traced what
"reject an exact_duplicate" would actually do, and realised the data needed to
reverse the action no longer existed.

**What I changed:** duplicates now **keep** their computed splits and are merely
marked with a non-`active` status (which the balance query already excludes). So
approve/reject/resolve is a simple status flip with no recomputation. (See
DECISIONS.md §10.)

### 3. A stray non-ASCII identifier that would not have compiled cleanly

**What it produced:** in the settlement-detection block the AI emitted a variable
named `blankالسplit` — it had spliced Arabic characters into the middle of the
identifier (an autocomplete/token glitch).

**How I caught it:** reviewing the importer line-by-line before running it; the
identifier was visibly garbled.

**What I changed:** renamed it to `blankSplit` and re-read the surrounding block to
confirm there were no other corrupted tokens, then ran the import to confirm the
settlement reclassification (rows 14 & 38) still worked.

## What I verified myself (not on the AI's word)

- Ran the importer against the real CSV and **hand-checked that all member nets
  sum to exactly ₹0.00**, before and after resolving a conflict and after adding
  manual expenses/settlements.
- Wrote and ran unit tests (`npm test`) for the money allocator (incl. the
  `100/3 → [34,33,33]` case and a negative-total refund), date parsing, and each
  split type — 21 tests.
- Traced one member's balance (Rohan) through the ledger endpoint and confirmed
  each line maps back to a CSV row number.
