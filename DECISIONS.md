# DECISIONS.md — decision log

Each significant decision, the options I considered, and why I chose what I did.

---

## 1. Money as integer minor units (paise), not floats

**Options:** (a) store rupees as floats/`NUMERIC`; (b) store integer paise.

**Chosen:** integer paise everywhere; format to rupees only for display.

**Why:** Splitting a bill three ways is the core operation and floats leak
fractions (`100/3` can't be represented). Integers make the arithmetic exact and
make the "shares sum to the total" invariant trivially checkable. `NUMERIC` would
also be exact but invites accidental float math in JS; integers are unambiguous.

---

## 2. Largest-remainder allocation for splits

**Options:** (a) round each share independently; (b) give the rounding remainder
to one fixed person; (c) largest-remainder (Hamilton) method.

**Chosen:** largest-remainder (`money.js → allocateByWeights`).

**Why:** Independent rounding doesn't sum back to the total (you lose/gain paise).
Largest-remainder distributes the leftover paise to the participants with the
largest fractional parts, so `Σ shares = total` **exactly**, deterministically,
and as fairly as integers allow. It also handles weighted (`share`) and negative
(refund) totals with the same code path.

---

## 3. Round-half-up to the paise for sub-minor amounts (e.g. `899.995`)

**Options:** round, floor, truncate, or reject.

**Chosen:** round half away from zero to the nearest paise.

**Why:** It matches what a person reading a receipt expects, is symmetric for
refunds, and rejecting would be hostile for a 0.5-paise artefact. The rounding is
surfaced as an anomaly so it's never silent. (The rounding rule lives in one
function, `roundHalfUp`, so the live "change the rounding rule" request is a
one-line edit.)

---

## 4. Fixed, documented FX rate — not a live API

**Options:** (a) call a live FX API at import time; (b) fixed rate table.

**Chosen:** fixed `USD→INR = 83.0` in `fx.js`, stored per-expense as `fx_rate`.

**Why:** A ledger must be **reproducible** — re-importing the same file must
produce the same balances. A live rate would change every run and couples the
import path to a network call. The trip dates are known, so one documented rate
is honest and auditable. Each converted expense stores its original amount,
currency, and the rate, so nothing is hidden (Priya's requirement). Changing the
rate is a one-line edit + re-import.

---

## 5. Time-bounded membership (resident vs guest)

**Options:** (a) a flat member list; (b) members with `joined_on/left_on`
windows enforced on every split.

**Chosen:** windows, with `member_type`:
- **resident** — window **enforced**; can't be in a split outside it.
- **guest** — no enforced window (Dev on the trip, Kabir for a day); still
  carries balances.

**Why:** This is the whole point of Sam's and Meera's complaints. Sam joined
2026-04-08, so March electricity can't touch him; Meera left end of March, so the
2026-04-02 grocery split drops her automatically. Guests are a separate type
because Dev legitimately appears across non-contiguous dates — enforcing a window
on him would wrongly drop him from his own expenses.

**Where membership comes from:** the app, not the CSV. Requirement #2 is
"membership can change over time", so membership is managed in the Members tab and
seeded from the assignment narrative (`roster.js`). The CSV import *respects*
membership; it doesn't define it.

---

## 6. Duplicates: exact vs conflicting are handled differently

**Options:** always keep the first / always keep the last / always merge / ask.

**Chosen:** classify by whether the rows agree:
- **Exact** (same date, amount, payer, fuzzy-same description → rows 5/6): keep
  the first, drop the rest as `duplicate`, flag for approval.
- **Conflicting** (same date & description but different amount/payer → rows
  24/25): **don't guess.** Hold both `pending_approval` and let a human pick the
  winner.

**Why:** "A silent guess is a failing answer." When the rows are identical,
keeping one is safe. When they disagree (₹2400 vs ₹2450, different payers), only a
human knows which is right — so the app surfaces both and excludes them from
balances until resolved. Description matching normalises case/punctuation and
drops stopwords ("at", "-") so "Dinner at Thalassa" ≡ "Thalassa dinner", but is
scoped to the **same date** to avoid merging the weekly "Groceries BigBasket".

---

## 7. Settlement / transfer reclassification

**Options:** keep "Rohan paid Aisha back" as an expense; delete it; or reclassify.

**Chosen:** reclassify rows that are really payments (blank `split_type`, or a
single counterparty + a payback/deposit keyword) into the `settlements` table;
flag for approval.

**Why:** A payback is not a shared cost — splitting it would double-count. Modeling
it as a settlement makes it reduce the payer's debt correctly. Rejecting the
reclassification quarantines the row for manual re-entry (we can't infer a split
that was never there).

---

## 8. Ambiguous date `04/05/2026` — order-based detection, not "both ≤ 12"

**Options:** (a) flag every slash date where day & month are both ≤ 12; (b) commit
to the file's DD/MM convention and only flag genuinely out-of-place dates.

**Chosen:** (b). The slash format is provably **DD/MM/YYYY** (rows like `15/03`,
`28/03` have day > 12). So `11/03` is *not* ambiguous given the file. The real
problem is row 34 (`04/05/2026`) sitting between 28 Mar and 1 Apr — a chronological
outlier. `flagOutOfOrderDates` flags exactly that row.

**Why:** Approach (a) produced ~2 false "ambiguous" flags (incl. a blameless
neighbour) and contradicted the fact that we *had* determined the format. Order
detection isolates the single true offender. (This was a real bug the AI
introduced — see AI_USAGE.md.)

---

## 9. Plain SQL via `pg`, not an ORM

**Options:** Prisma/Sequelize/Drizzle vs raw SQL.

**Chosen:** raw parameterised SQL with `node-postgres`.

**Why:** The hard part of this app is arithmetic and import policy, not data
modelling. The evaluators will point at any line and ask why it exists — raw SQL
keeps every query visible with no generated-client indirection, and the balance
query (the thing most likely to be walked through by hand) reads exactly like the
math in `compute.js`. Parameterised queries prevent injection.

---

## 10. Approval model that keeps the books usable

**Options:** (a) apply nothing until approved (books empty after import); (b) apply
documented policy immediately, log it, and let Meera approve/reject.

**Chosen:** (b). Destructive/ambiguous actions (duplicates, conflicts, missing
payer) are excluded from balances pending approval; everything else is applied and
logged. Duplicate rows **keep their computed splits** so approve/reject is a
simple status flip (no recomputation).

**Why:** An import that produces nothing until every anomaly is hand-approved is
useless on day one. Applying a documented default and surfacing it for review
gives a working ledger immediately while honouring Meera's veto.

---

## 11. Auth: JWT in an httpOnly cookie

**Options:** server sessions table vs stateless JWT; localStorage vs cookie.

**Chosen:** stateless JWT in an httpOnly cookie (also accepted as a Bearer token
for API testing).

**Why:** Stateless fits a serverless deployment (no session store round-trip). An
httpOnly cookie keeps the token out of reach of JS (XSS-safer than localStorage).
Trade-off: no server-side revocation before expiry — acceptable for this app, and
the 7-day expiry bounds it.

---

## 12. Deploy: one Vercel project, Express as a serverless function

**Options:** separate API host (Railway/Render) + static frontend; or one Vercel
project serving both.

**Chosen:** one Vercel project. `client/dist` is served statically; `api/index.js`
exports the **same** Express app as a serverless function; `vercel.json` routes
`/api/*` to it and everything else to the SPA.

**Why:** Same origin means cookies "just work" with no CORS dance, one deploy, one
URL. The app factory (`createApp`) is shared by local dev and the function, so
there's no prod-only code path to surprise me. For DB connections I use Neon's
**pooled** endpoint because serverless opens many short-lived connections.
