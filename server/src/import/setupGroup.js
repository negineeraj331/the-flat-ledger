// ============================================================================
// setupGroup.js — create a group and seed its roster + aliases.
// ============================================================================
// Used by the import flow and the CLI. Idempotent-ish: members are upserted by
// (group_id, name). Membership windows come from roster.js.
// ============================================================================
import { DEFAULT_GROUP, DEFAULT_ROSTER, DEFAULT_ALIASES } from './roster.js';

/**
 * Ensure a group with the given name exists; seed members + aliases.
 * @returns the group row { id, name, base_currency }
 */
export async function setupDefaultGroup(client, {
  group = DEFAULT_GROUP,
  roster = DEFAULT_ROSTER,
  aliases = DEFAULT_ALIASES,
  createdBy = null,
} = {}) {
  const g = await client.query(
    `INSERT INTO groups (name, base_currency, created_by)
     VALUES ($1,$2,$3) RETURNING id, name, base_currency`,
    [group.name, group.base_currency, createdBy]
  );
  const groupRow = g.rows[0];

  const nameToId = {};
  for (const m of roster) {
    const r = await client.query(
      `INSERT INTO members (group_id, name, member_type, joined_on, left_on)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name`,
      [groupRow.id, m.name, m.member_type, m.joined_on, m.left_on]
    );
    nameToId[m.name] = r.rows[0].id;
  }

  for (const a of aliases) {
    const memberId = nameToId[a.canonical];
    if (!memberId) continue;
    await client.query(
      `INSERT INTO member_aliases (group_id, raw_name, member_id)
       VALUES ($1,$2,$3) ON CONFLICT (group_id, raw_name) DO NOTHING`,
      [groupRow.id, a.raw_name.toLowerCase(), memberId]
    );
  }

  return groupRow;
}
