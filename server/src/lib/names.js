// ============================================================================
// names.js — resolve the many spellings of a person to one canonical member.
// ============================================================================
// The CSV refers to the same people inconsistently:
//   "Priya", "priya", "Priya S"      -> Priya
//   "Rohan", "rohan " (trailing ws)  -> Rohan
//   "Dev's friend Kabir"             -> Kabir (a guest)
//
// Strategy (kept deliberately simple and explainable):
//   1. normaliseName(): lowercase, collapse whitespace, strip a trailing single
//      initial like "S" in "Priya S". This produces a match KEY.
//   2. A NameResolver holds a map from key -> canonical member name, seeded from
//      the known roster. Lookups that miss are reported so the importer can flag
//      an unknown participant rather than silently inventing one.
// ============================================================================

/**
 * Produce a normalised match key for a raw name.
 *   - trims and lowercases
 *   - collapses internal whitespace
 *   - strips a trailing single-letter "initial" (e.g. "priya s" -> "priya")
 *   - extracts a trailing capitalised guest name from "X's friend Kabir"
 */
export function normaliseName(raw) {
  if (raw == null) return '';
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === '') return '';

  // "dev's friend kabir" / "x's mate y" -> take the last word as the person.
  const friendMatch = s.match(/(?:'s\s+(?:friend|mate|guest)\s+)([a-z]+)$/);
  if (friendMatch) {
    return friendMatch[1];
  }

  // Trailing single-letter surname initial: "priya s" -> "priya".
  s = s.replace(/\s+[a-z]$/, '');

  return s;
}

export class NameResolver {
  /**
   * @param {Array<{id:number,name:string}>} members canonical roster
   * @param {Array<{raw_name:string,member_id:number}>} [aliases] persisted aliases
   */
  constructor(members = [], aliases = []) {
    this.byKey = new Map();   // normalised key -> member
    this.byId = new Map();    // id -> member
    for (const mem of members) {
      this.byId.set(mem.id, mem);
      this.byKey.set(normaliseName(mem.name), mem);
    }
    for (const a of aliases) {
      const mem = this.byId.get(a.member_id);
      if (mem) this.byKey.set(normaliseName(a.raw_name), mem);
    }
  }

  /**
   * Resolve a raw name to a member.
   * @returns {{ member: object|null, key: string, normalisedFromRaw: boolean }}
   *   member === null means "no known member matches" (caller should flag).
   *   normalisedFromRaw === true means the raw string differed from the
   *   canonical name (a variant was matched) — useful for the anomaly log.
   */
  resolve(raw) {
    const key = normaliseName(raw);
    const member = this.byKey.get(key) ?? null;
    const normalisedFromRaw =
      member != null && String(raw).trim() !== member.name;
    return { member, key, normalisedFromRaw };
  }
}
