// ============================================================================
// importer.js — the messy-CSV ingestion pipeline.
// ============================================================================
// Contract for every detected problem (from the assignment):
//   1. DETECT it   2. SURFACE it (write an import_anomalies row)   3. HANDLE it
//      with a documented policy (never crash, never silently guess).
//
// Pipeline:
//   Phase 1  normaliseRow()  — clean & validate each field, collect anomalies,
//                              compute per-member splits, decide a tentative
//                              status (active / quarantined / skipped /
//                              settlement).
//   Phase 2  markDuplicates() — cross-row pass: exact duplicates are dropped,
//                              conflicting duplicates are held for approval.
//   Phase 3  persist()       — write expenses, splits, settlements, anomalies
//                              inside the caller's transaction.
//
// Every anomaly carries a stable `anomaly_type` (catalogued in SCOPE.md), a
// severity, a human message, the `action` taken, and whether it needs approval.
// ============================================================================
import { parseCsv } from './parseCsv.js';
import { NameResolver, normaliseName } from '../lib/names.js';
import { parseAmountToMinor } from '../lib/money.js';
import { convertMinor, isSupportedCurrency } from '../lib/fx.js';
import { parseDate } from '../lib/dates.js';
import { isActiveOn } from './roster.js';
import {
  computeEqual, computeShares, computeUnequal, computePercentage,
} from './splitEngine.js';

const SETTLEMENT_KEYWORDS = /\b(paid .* back|paid back|payback|repaid|settle|settlement|reimburs|deposit)\b/i;
const DESC_STOPWORDS = new Set(['at', 'the', 'a', 'an', 'for', 'on', 'of', 'to', 'order']);

// ---------------------------------------------------------------------------
// Public entry point. `client` is a pg client already inside a transaction.
// ---------------------------------------------------------------------------
export async function importCsvText({ client, text, group, importRunId }) {
  const rows = parseCsv(text);

  // Load the roster + aliases and build a name resolver. Guests discovered
  // mid-import are inserted and added to the resolver on the fly.
  const members = await loadMembers(client, group.id);
  const aliases = await loadAliases(client, group.id);
  const resolver = new NameResolver(members, aliases);
  const ctx = { client, group, resolver, members };

  // Phase 1 — normalise every row independently.
  const parsed = [];
  for (const row of rows) {
    parsed.push(await normaliseRow(row, ctx));
  }

  // Phase 1b — chronological sanity pass: flag dates that sit out of order in
  // the file (the real "is this Apr 5 or May 4?" ambiguity, row 34).
  flagOutOfOrderDates(parsed);

  // Phase 2 — duplicate detection across rows.
  markDuplicates(parsed);

  // Phase 3 — persist.
  const anomalies = await persist(client, group, importRunId, parsed);

  const imported = parsed.filter((p) => p.status === 'active').length;
  return {
    totalRows: rows.length,
    importedRows: imported,
    anomalies,
    parsed,
  };
}

// ===========================================================================
// Phase 1: normalise a single row.
// ===========================================================================
async function normaliseRow(row, ctx) {
  const anomalies = [];
  const add = (type, severity, message, action, needsApproval = false) =>
    anomalies.push({ source_row: row._row, type, severity, message, action,
      status: needsApproval ? 'pending_approval' : 'auto' });

  const p = {
    source_row: row._row,
    raw: row,
    anomalies,
    status: 'active',
    kind: 'expense',
    description: (row.description ?? '').trim() || '(no description)',
    notes: (row.notes ?? '').trim() || null,
  };

  // --- date ---------------------------------------------------------------
  const d = parseDate(row.date);
  if (d.iso == null) {
    p.spent_on = null;
    p.status = 'quarantined';
    add('unparseable_date', 'error', `Could not parse date "${row.date}".`,
      'quarantined row until a valid date is supplied', true);
  } else {
    p.spent_on = d.iso;
    // The slash format is established as DD/MM/YYYY (some rows have day > 12),
    // so a plain DD/MM date is NOT treated as per-row ambiguous — that would be
    // noise. Genuine ambiguity (a date that sits out of chronological order, the
    // "04/05/2026 = Apr 5 or May 4?" case) is detected in a separate order pass.
    if (d.format !== 'ISO') {
      const sev = d.format.startsWith('Mon') ? 'warning' : 'info';
      add('date_normalised', sev,
        `Date "${row.date}" (${d.format}) normalised to ${d.iso}.`,
        `normalised to ${d.iso}`);
    }
  }

  // --- amount + currency --------------------------------------------------
  const amt = parseAmountToMinor(row.amount);
  if (amt.minor == null) {
    p.original_amount_minor = 0;
    p.amount_minor = 0;
    p.status = 'quarantined';
    add('unparseable_amount', 'error', `Could not parse amount "${row.amount}".`,
      'quarantined row', true);
  } else {
    p.original_amount_minor = amt.minor;
    if (amt.hadComma) add('amount_thousands_separator', 'info',
      `Amount "${row.amount}" contained a thousands separator.`, 'stripped commas');
    if (amt.hadWhitespace) add('amount_whitespace', 'info',
      `Amount "${row.amount}" had surrounding whitespace.`, 'trimmed');
    if (amt.hadSubMinor) add('amount_sub_minor', 'warning',
      `Amount "${row.amount}" had sub-paise precision; rounded to nearest paise.`,
      'rounded half-up to paise');
  }

  // currency: default to base currency if missing, flag if unsupported.
  let currency = (row.currency ?? '').trim().toUpperCase();
  if (currency === '') {
    currency = ctx.group.base_currency;
    add('missing_currency', 'warning',
      `Currency missing; defaulted to group base ${currency}.`,
      `defaulted to ${currency}`, true);
  } else if (!isSupportedCurrency(currency, ctx.group.base_currency)) {
    add('unsupported_currency', 'error',
      `Currency ${currency} has no configured FX rate.`, 'quarantined row', true);
    p.status = 'quarantined';
  }
  p.original_currency = currency;

  // convert to base currency (records the rate for auditability).
  if (p.status !== 'quarantined') {
    const conv = convertMinor(p.original_amount_minor, currency, ctx.group.base_currency);
    p.amount_minor = conv.minor;
    p.fx_rate = conv.rate;
    if (currency !== ctx.group.base_currency) {
      add('currency_converted', 'info',
        `${currency} ${(p.original_amount_minor / 100).toFixed(2)} converted to ` +
        `${ctx.group.base_currency} at rate ${conv.rate}.`,
        `converted at ${conv.rate}`);
    }
  } else {
    p.amount_minor = 0;
    p.fx_rate = 1;
  }

  // negative => refund; zero => skip.
  if (p.original_amount_minor < 0) {
    add('negative_amount', 'warning',
      `Negative amount (${row.amount}) treated as a refund, not an error.`,
      'kept as refund (negative shares)');
  } else if (p.original_amount_minor === 0 && p.status === 'active') {
    p.status = 'skipped';
    add('zero_amount', 'warning',
      `Zero amount; row has no financial effect.`, 'skipped (excluded from balances)', true);
  }

  // --- payer --------------------------------------------------------------
  const payerRaw = (row.paid_by ?? '').trim();
  if (payerRaw === '') {
    p.paid_by = null;
    if (p.status === 'active') p.status = 'quarantined';
    add('missing_payer', 'error',
      `No payer recorded ("${(row.notes || '').trim()}"). Cannot compute who is owed.`,
      'quarantined until a payer is assigned', true);
  } else {
    const r = ctx.resolver.resolve(payerRaw);
    if (!r.member) {
      // payer is an unknown person -> create a guest so the row is usable.
      const guest = await ensureGuest(ctx, payerRaw);
      p.paid_by = guest.id;
      add('unknown_payer', 'warning',
        `Payer "${payerRaw}" is not a known member; added as guest "${guest.name}".`,
        'created guest member', true);
    } else {
      p.paid_by = r.member.id;
      if (r.normalisedFromRaw) add('payer_name_variant', 'info',
        `Payer "${payerRaw}" matched member "${r.member.name}".`, 'normalised name');
      if (p.spent_on && !isActiveOn(r.member, p.spent_on)) add('payer_inactive', 'warning',
        `Payer "${r.member.name}" was not an active member on ${p.spent_on}.`, 'kept payer, flagged');
    }
  }

  // --- detect "this is really a settlement / transfer" --------------------
  const participantsRaw = splitList(row.split_with);
  const blankSplit = (row.split_type ?? '').trim() === '';
  const singleCounterparty = participantsRaw.length === 1;
  const looksLikeTransfer =
    blankSplit ||
    (singleCounterparty && SETTLEMENT_KEYWORDS.test(`${p.description} ${p.notes || ''}`));

  if (looksLikeTransfer && p.paid_by != null && participantsRaw.length >= 1) {
    const toRes = ctx.resolver.resolve(participantsRaw[0]);
    const toMember = toRes.member || (await ensureGuest(ctx, participantsRaw[0]));
    if (toMember.id !== p.paid_by) {
      p.kind = 'settlement';
      p.settlement = { from: p.paid_by, to: toMember.id };
      // a settlement is "valid" (counts via the settlements table) but is not a
      // shared expense, so it carries no splits.
      p.splits = [];
      add('settlement_logged_as_expense', 'warning',
        `Row looks like a payment (${SETTLEMENT_KEYWORDS.test(`${p.description} ${p.notes||''}`) ? 'keyword' : 'blank split_type'}); ` +
        `reclassified as a settlement to "${toMember.name}".`,
        'reclassified as settlement', true);
      return p; // settlements skip the split computation below
    }
  }

  // --- split computation --------------------------------------------------
  if (p.status === 'quarantined' || p.status === 'skipped') {
    p.splits = [];
    return p;
  }

  const splitType = (row.split_type ?? '').trim().toLowerCase() || 'equal';
  p.split_type = splitType;
  const details = parseSplitDetails(row.split_details);

  // resolve the participant list (from split_with for equal; from details
  // otherwise) into active members, dropping/ flagging as needed.
  const built = await buildParticipants(ctx, p, splitType, participantsRaw, details, add);
  if (built.length === 0) {
    p.status = 'quarantined';
    p.splits = [];
    add('no_valid_participants', 'error',
      'No valid participants remained for this split.', 'quarantined row', true);
    return p;
  }

  let result;
  switch (splitType) {
    case 'equal':
      // If details were supplied for an equal split, honour split_type and flag.
      if (details.length > 0) add('split_details_ignored', 'info',
        `split_type=equal but split_details were present; honoured equal split.`,
        'ignored split_details');
      result = computeEqual(p.amount_minor, built.map((b) => b.member));
      break;
    case 'share':
      result = computeShares(p.amount_minor, built.map((b) => ({ member: b.member, weight: b.weight })));
      break;
    case 'unequal':
      result = computeUnequal(p.amount_minor, built.map((b) => ({ member: b.member, amount_minor: b.amount_minor })));
      break;
    case 'percentage':
      result = computePercentage(p.amount_minor, built.map((b) => ({ member: b.member, pct: b.pct })));
      break;
    default:
      add('unknown_split_type', 'error', `Unknown split_type "${splitType}".`,
        'quarantined row', true);
      p.status = 'quarantined';
      p.splits = [];
      return p;
  }

  for (const a of result.anomalies) add(a.type, a.severity, a.message, 'see policy', a.severity === 'error');
  p.splits = result.shares.map((s) => ({ member_id: s.member.id, share_minor: s.share_minor }));
  if (result.shares.length === 0) {
    p.status = 'quarantined';
  }
  return p;
}

// ---------------------------------------------------------------------------
// Build the participant list for a split, resolving names, enforcing resident
// membership windows, and attaching the per-type weight/amount/pct.
// ---------------------------------------------------------------------------
async function buildParticipants(ctx, p, splitType, participantsRaw, details, add) {
  // Source of truth: details for typed splits, split_with for equal.
  const source = splitType === 'equal' ? participantsRaw.map((name) => ({ name }))
                                       : details;
  const out = [];
  for (const entry of source) {
    const res = ctx.resolver.resolve(entry.name);
    let member = res.member;
    if (!member) {
      member = await ensureGuest(ctx, entry.name);
      add('unknown_participant', 'warning',
        `Participant "${entry.name}" is not a known member; added as guest "${member.name}".`,
        'created guest member', true);
    } else if (res.normalisedFromRaw) {
      add('participant_name_variant', 'info',
        `Participant "${entry.name}" matched member "${member.name}".`, 'normalised name');
    }
    // enforce resident membership window
    if (p.spent_on && !isActiveOn(member, p.spent_on)) {
      add('inactive_member_in_split', 'warning',
        `"${member.name}" was not an active member on ${p.spent_on}; removed from this split.`,
        'dropped from split & re-split among active members', true);
      continue;
    }
    out.push({
      member,
      weight: entry.weight,
      pct: entry.pct,
      amount_minor: entry.amount_minor,
    });
  }
  return out;
}

// ===========================================================================
// Phase 1b: chronological order sanity.
// ===========================================================================
// The CSV rows are otherwise in date order. A row whose date is a strict local
// extremum (greater than BOTH neighbours, or smaller than both) is out of place
// and likely a misread date — e.g. row 34 "04/05/2026" interpreted as 4 May
// sticks out between 28 Mar and 1 Apr. We flag it for human confirmation rather
// than silently trusting our DD/MM interpretation.
function flagOutOfOrderDates(parsed) {
  const dated = parsed.filter((p) => p.spent_on && p.status !== 'quarantined');
  for (let i = 1; i < dated.length - 1; i++) {
    const prev = dated[i - 1].spent_on;
    const cur = dated[i].spent_on;
    const next = dated[i + 1].spent_on;
    // Only blame `cur` when its neighbours are themselves consistent (ascending)
    // yet `cur` falls outside [prev, next]. This isolates the single intruder
    // (row 34) instead of also flagging its blameless neighbour (row 35).
    const neighboursConsistent = prev < next;
    const curIsIntruder = cur < prev || cur > next;
    if (neighboursConsistent && curIsIntruder) {
      dated[i].anomalies.push({
        source_row: dated[i].source_row, type: 'ambiguous_date', severity: 'warning',
        message: `Date "${dated[i].raw.date}" sits out of chronological order ` +
          `(interpreted as ${cur}, but neighbours are ${prev} and ${next}). ` +
          `Likely a misread day/month — confirm the intended date.`,
        action: `kept as ${cur}, flagged for confirmation`, status: 'pending_approval',
      });
    }
  }
}

// ===========================================================================
// Phase 2: duplicate detection.
// ===========================================================================
function markDuplicates(parsed) {
  const groups = new Map(); // key(date|descKey) -> [parsed]
  for (const p of parsed) {
    if (p.status !== 'active' || p.kind !== 'expense' || !p.spent_on) continue;
    const key = `${p.spent_on}|${descKey(p.description)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  for (const [, rows] of groups) {
    if (rows.length < 2) continue;
    const samePayer = rows.every((r) => r.paid_by === rows[0].paid_by);
    const sameAmount = rows.every((r) => r.amount_minor === rows[0].amount_minor);

    if (samePayer && sameAmount) {
      // exact duplicate: keep the first, drop the rest.
      rows.slice(1).forEach((r) => {
        r.status = 'duplicate';
        // keep the computed splits so approving/rejecting is a simple status
        // flip (the balance query excludes non-'active' rows anyway).
        r.anomalies.push({
          source_row: r.source_row, type: 'exact_duplicate', severity: 'warning',
          message: `Exact duplicate of row ${rows[0].source_row} (same date, amount, payer, description). Dropped.`,
          action: 'dropped duplicate (excluded from balances)', status: 'pending_approval',
        });
      });
    } else {
      // conflicting duplicate: don't guess — hold ALL for human resolution.
      const siblingRows = rows.map((r) => r.source_row).join(', ');
      rows.forEach((r) => {
        r.status = 'pending_approval'; // excluded from balances until resolved
        // splits are kept so resolving = flip the winner to 'active'.
        r.anomalies.push({
          source_row: r.source_row, type: 'conflicting_duplicate', severity: 'warning',
          message: `Possible duplicate of rows [${siblingRows}] with differing amount/payer. ` +
            `Held for review — pick the correct row.`,
          action: 'held for approval (excluded from balances)', status: 'pending_approval',
        });
      });
    }
  }
}

// ===========================================================================
// Phase 3: persist everything in the caller's transaction.
// ===========================================================================
async function persist(client, group, importRunId, parsed) {
  const allAnomalies = [];
  for (const p of parsed) {
    const exp = await client.query(
      `INSERT INTO expenses
         (group_id, spent_on, description, paid_by, amount_minor,
          original_amount_minor, original_currency, fx_rate, split_type,
          kind, status, notes, source_row, import_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [group.id, p.spent_on, p.description, p.paid_by, p.amount_minor,
       p.original_amount_minor, p.original_currency, p.fx_rate ?? 1,
       p.split_type ?? 'equal', p.kind, p.status, p.notes, p.source_row, importRunId]
    );
    const expenseId = exp.rows[0].id;
    p.expense_id = expenseId;

    // splits
    for (const s of p.splits ?? []) {
      await client.query(
        `INSERT INTO expense_splits (expense_id, member_id, share_minor)
         VALUES ($1,$2,$3)`,
        [expenseId, s.member_id, s.share_minor]
      );
    }

    // settlement mirror
    if (p.kind === 'settlement' && p.settlement) {
      await client.query(
        `INSERT INTO settlements
           (group_id, paid_on, from_member, to_member, amount_minor, note, source_row, expense_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [group.id, p.spent_on, p.settlement.from, p.settlement.to,
         p.amount_minor, p.description, p.source_row, expenseId]
      );
    }

    // anomalies
    for (const a of p.anomalies) {
      const saved = await client.query(
        `INSERT INTO import_anomalies
           (import_run_id, group_id, source_row, anomaly_type, severity,
            message, action, status, raw_row, expense_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [importRunId, group.id, a.source_row, a.type, a.severity, a.message,
         a.action, a.status, JSON.stringify(p.raw), expenseId]
      );
      allAnomalies.push({ id: saved.rows[0].id, ...a, expense_id: expenseId });
    }
  }
  return allAnomalies;
}

// ===========================================================================
// helpers
// ===========================================================================
function splitList(raw) {
  if (!raw) return [];
  return String(raw).split(';').map((s) => s.trim()).filter(Boolean);
}

/** parse "Name 700; Other 400" or "Aisha 30%; ..." or "Aisha 1; Rohan 2". */
function parseSplitDetails(raw) {
  if (!raw) return [];
  return splitList(raw).map((piece) => {
    const m = piece.match(/^(.*?)[\s]+([\d.]+)\s*(%?)$/);
    if (!m) return { name: piece, weight: 1, pct: 0, amount_minor: 0 };
    const name = m[1].trim();
    const num = Number(m[2]);
    const isPct = m[3] === '%';
    return {
      name,
      weight: num,
      pct: isPct ? num : num,         // for percentage splits we read pct
      amount_minor: Math.round(num * 100), // for unequal splits we read amount
    };
  });
}

function descKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !DESC_STOPWORDS.has(w))
    .sort()
    .join(' ');
}

async function loadMembers(client, groupId) {
  const r = await client.query(
    `SELECT id, name, member_type, joined_on::text, left_on::text FROM members WHERE group_id=$1`,
    [groupId]
  );
  return r.rows;
}

async function loadAliases(client, groupId) {
  const r = await client.query(
    `SELECT raw_name, member_id FROM member_aliases WHERE group_id=$1`, [groupId]
  );
  return r.rows;
}

/** create (or fetch) a guest member for an unknown name and register it. */
async function ensureGuest(ctx, rawName) {
  const existing = ctx.resolver.resolve(rawName);
  if (existing.member) return existing.member;
  // Use the normalised display: title-case the resolved key.
  const key = normaliseName(rawName);
  const display = key.replace(/\b\w/g, (c) => c.toUpperCase());
  const r = await ctx.client.query(
    `INSERT INTO members (group_id, name, member_type) VALUES ($1,$2,'guest')
     ON CONFLICT (group_id, name) DO UPDATE SET name=EXCLUDED.name
     RETURNING id, name, member_type, joined_on::text, left_on::text`,
    [ctx.group.id, display]
  );
  const member = r.rows[0];
  ctx.members.push(member);
  ctx.resolver.byId.set(member.id, member);
  ctx.resolver.byKey.set(key, member);
  return member;
}
