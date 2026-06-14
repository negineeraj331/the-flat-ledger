// ============================================================================
// roster.js — the group's membership, with time windows.
// ============================================================================
// Membership is a PRODUCT concept (requirement #2: "membership can change over
// time"), not something the CSV declares. These windows come from the assignment
// narrative and the flatmates themselves:
//   * Aisha, Rohan, Priya  — residents since the group started (Feb 2026).
//   * Meera                — resident who moved out end of March 2026.
//   * Sam                  — resident who moved in 2026-04-08 (his deposit row).
//   * Dev                  — a GUEST who joined the group for the Goa trip; he
//                            carries balances but has no enforced window.
//   * Kabir                — a GUEST ("Dev's friend Kabir") for one trip day.
//
// The importer enforces resident windows: a resident cannot be part of a split
// dated outside [joined_on, left_on]. This is what makes Sam's "why would March
// electricity affect me?" and Meera's post-move-out rows behave correctly.
//
// Guests created by the import (anyone named in the CSV who isn't here) default
// to member_type 'guest' with no window and are flagged.
// ============================================================================

export const DEFAULT_GROUP = {
  name: 'Flat 4B',
  base_currency: 'INR',
};

export const DEFAULT_ROSTER = [
  { name: 'Aisha', member_type: 'resident', joined_on: '2026-02-01', left_on: null },
  { name: 'Rohan', member_type: 'resident', joined_on: '2026-02-01', left_on: null },
  { name: 'Priya', member_type: 'resident', joined_on: '2026-02-01', left_on: null },
  { name: 'Meera', member_type: 'resident', joined_on: '2026-02-01', left_on: '2026-03-31' },
  { name: 'Sam',   member_type: 'resident', joined_on: '2026-04-08', left_on: null },
  { name: 'Dev',   member_type: 'guest',    joined_on: null,         left_on: null },
];

// Known aliases -> canonical name. normaliseName() already collapses case,
// whitespace and trailing initials; these cover anything it can't infer.
export const DEFAULT_ALIASES = [
  { raw_name: 'priya s', canonical: 'Priya' },
];

/**
 * Is `member` active on ISO date `iso`? Guests are always considered active
 * (no enforced window). Residents must be within [joined_on, left_on].
 */
export function isActiveOn(member, iso) {
  if (member.member_type === 'guest') return true;
  if (!iso) return true; // undated rows are handled elsewhere
  if (member.joined_on && iso < member.joined_on) return false;
  if (member.left_on && iso > member.left_on) return false;
  return true;
}
