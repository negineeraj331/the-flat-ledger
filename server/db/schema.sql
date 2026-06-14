-- ============================================================================
-- Shared Expenses App — relational schema (PostgreSQL)
-- ============================================================================
-- Design principles (see DECISIONS.md for the full reasoning):
--   1. All money is stored as INTEGER minor units (paise) in the group's base
--      currency. Floats are never stored. This makes split arithmetic exact.
--   2. Every expense keeps its ORIGINAL amount + currency + fx rate so that a
--      converted value can always be traced back to the source row (Priya's
--      "a dollar isn't a rupee" + Rohan's "no magic numbers" requirements).
--   3. Membership is time-bounded (joined_on / left_on) so an expense only ever
--      splits among members active on the expense date (Sam's + Meera's reqs).
--   4. The import pipeline never silently mutates data. Every detected problem
--      is written to import_anomalies with the action taken, and any row that
--      is deleted/changed/reclassified is held for human approval.
-- ============================================================================

-- Drop in reverse-dependency order so the file is re-runnable in dev.
DROP TABLE IF EXISTS import_anomalies   CASCADE;
DROP TABLE IF EXISTS import_runs        CASCADE;
DROP TABLE IF EXISTS settlements        CASCADE;
DROP TABLE IF EXISTS expense_splits     CASCADE;
DROP TABLE IF EXISTS expenses           CASCADE;
DROP TABLE IF EXISTS member_aliases     CASCADE;
DROP TABLE IF EXISTS members            CASCADE;
DROP TABLE IF EXISTS group_users        CASCADE;
DROP TABLE IF EXISTS groups             CASCADE;
DROP TABLE IF EXISTS users              CASCADE;

-- ---------------------------------------------------------------------------
-- users — authentication accounts (the Login module).
-- A user is a person who can log in. They are distinct from "members", who are
-- the entities that participate in expenses (a flatmate may exist as a member
-- before they ever create a login).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- groups — a shared-expense group (e.g. "Flat 4B").
-- base_currency is the single currency all balances are reported in. Every
-- expense is converted into this currency at import/create time.
-- ---------------------------------------------------------------------------
CREATE TABLE groups (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  base_currency CHAR(3) NOT NULL DEFAULT 'INR',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- group_users — which login accounts can access which group, and their role.
-- ---------------------------------------------------------------------------
CREATE TABLE group_users (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  PRIMARY KEY (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- members — a participant in a group's expenses (Aisha, Rohan, Dev, ...).
--   member_type:
--     'resident' — a flatmate. Membership window (joined_on/left_on) is
--                  ENFORCED: they cannot be in a split outside their window.
--     'guest'    — a transient participant (Dev on the trip, Kabir for a day).
--                  Window is NOT enforced; they may appear in any expense they
--                  are listed in. Guests still carry balances.
--   left_on NULL  => still active.
--   user_id       => optional link to a login account.
-- ---------------------------------------------------------------------------
CREATE TABLE members (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                 -- canonical display name
  member_type TEXT NOT NULL DEFAULT 'resident',
  joined_on   DATE,                          -- NULL => since the beginning
  left_on     DATE,                          -- NULL => still active
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (group_id, name)
);

-- ---------------------------------------------------------------------------
-- member_aliases — maps a raw name string from the CSV to a canonical member.
-- The import normaliser writes/reads this so that "priya", "Priya S" and
-- "Priya" all resolve to the same member, and so the mapping is auditable.
-- ---------------------------------------------------------------------------
CREATE TABLE member_aliases (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  raw_name    TEXT NOT NULL,                 -- normalised key, e.g. "priya s"
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  UNIQUE (group_id, raw_name)
);

-- ---------------------------------------------------------------------------
-- expenses — one shared expense (the header). The per-person breakdown lives
-- in expense_splits.
--   kind:
--     'expense'    — a normal shared cost.
--     'settlement' — a row that was actually a payment between two people and
--                    was reclassified out of the expense set (e.g. "Rohan paid
--                    Aisha back"). Kept here for traceability but mirrored into
--                    the settlements table for balance math.
--   status:
--     'active'             — counts toward balances.
--     'duplicate'          — detected duplicate, excluded from balances.
--     'quarantined'        — cannot be computed (e.g. missing payer); excluded
--                            until a human resolves it.
--     'skipped'            — intentionally ignored (e.g. zero amount).
--     'pending_approval'   — applied a non-trivial transform; awaiting sign-off
--                            (Meera's "approve anything you delete or change").
--   amount_minor          — final amount in the group base currency (paise).
--   original_amount_minor — amount as it appeared, in original currency minor units.
--   original_currency     — currency as it appeared (or inferred).
--   fx_rate               — multiplier applied to convert original -> base (1.0 if same).
-- ---------------------------------------------------------------------------
CREATE TABLE expenses (
  id                    SERIAL PRIMARY KEY,
  group_id              INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  spent_on              DATE,                 -- NULL only if unparseable (then quarantined)
  description           TEXT NOT NULL,
  paid_by               INTEGER REFERENCES members(id) ON DELETE SET NULL,
  amount_minor          BIGINT NOT NULL,
  original_amount_minor BIGINT NOT NULL,
  original_currency     CHAR(3) NOT NULL,
  fx_rate               NUMERIC(14,6) NOT NULL DEFAULT 1.0,
  split_type            TEXT NOT NULL,        -- equal|unequal|percentage|share
  kind                  TEXT NOT NULL DEFAULT 'expense',
  status                TEXT NOT NULL DEFAULT 'active',
  notes                 TEXT,
  source_row            INTEGER,              -- 1-based CSV line (incl. header) for traceability
  import_run_id         INTEGER,              -- set below via FK once import_runs exists
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- expense_splits — how much each member OWES for a given expense, in base-
-- currency minor units. SUM(share_minor) for an expense always equals the
-- expense amount_minor exactly (largest-remainder allocation guarantees this).
-- A negative share_minor is valid (refund rows distribute a credit).
-- ---------------------------------------------------------------------------
CREATE TABLE expense_splits (
  id          SERIAL PRIMARY KEY,
  expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  share_minor BIGINT NOT NULL,
  UNIQUE (expense_id, member_id)
);

-- ---------------------------------------------------------------------------
-- settlements — a payment from one member to another (records a debt being
-- paid, or a reclassified "X paid Y back" row). Reduces what the payer owes.
-- ---------------------------------------------------------------------------
CREATE TABLE settlements (
  id           SERIAL PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  paid_on      DATE,
  from_member  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  to_member    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount_minor BIGINT NOT NULL,
  note         TEXT,
  source_row   INTEGER,
  expense_id   INTEGER REFERENCES expenses(id) ON DELETE SET NULL, -- if reclassified from an expense
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- import_runs — one row per CSV import. Holds the summary counts used by the
-- import report.
-- ---------------------------------------------------------------------------
CREATE TABLE import_runs (
  id             SERIAL PRIMARY KEY,
  group_id       INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  filename       TEXT,
  total_rows     INTEGER NOT NULL DEFAULT 0,
  imported_rows  INTEGER NOT NULL DEFAULT 0,
  anomaly_count  INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE expenses
  ADD CONSTRAINT expenses_import_run_fk
  FOREIGN KEY (import_run_id) REFERENCES import_runs(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- import_anomalies — the audit log of every data problem detected during an
-- import. This table directly backs the "Import report" deliverable and the
-- approval queue (Meera's requirement).
--   severity: 'info' | 'warning' | 'error'
--   action  : machine-readable action taken (e.g. 'dropped_duplicate',
--             'normalized_percentages', 'reclassified_settlement', ...)
--   status  : 'auto'             — handled automatically, no approval needed
--             'pending_approval' — awaiting human sign-off
--             'approved'         — human approved the action
--             'rejected'         — human rejected; action should be reverted
-- ---------------------------------------------------------------------------
CREATE TABLE import_anomalies (
  id            SERIAL PRIMARY KEY,
  import_run_id INTEGER NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_row    INTEGER,                 -- 1-based CSV line
  anomaly_type  TEXT NOT NULL,           -- stable code, see SCOPE.md
  severity      TEXT NOT NULL DEFAULT 'warning',
  message       TEXT NOT NULL,           -- human-readable explanation
  action        TEXT NOT NULL,           -- what the importer did
  status        TEXT NOT NULL DEFAULT 'auto',
  raw_row       JSONB,                   -- the original CSV row, for tracing
  expense_id    INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful indexes for the read paths (balances, expense lists, reports).
CREATE INDEX idx_expenses_group        ON expenses(group_id);
CREATE INDEX idx_expenses_status       ON expenses(group_id, status);
CREATE INDEX idx_splits_expense        ON expense_splits(expense_id);
CREATE INDEX idx_splits_member         ON expense_splits(member_id);
CREATE INDEX idx_settlements_group     ON settlements(group_id);
CREATE INDEX idx_anomalies_run         ON import_anomalies(import_run_id);
CREATE INDEX idx_members_group         ON members(group_id);
