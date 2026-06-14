// ============================================================================
// routes/members.js — manage group membership over time (join/leave).
// ============================================================================
// Membership windows (joined_on/left_on) are first-class: this is how the app
// represents "Meera moved out" and "Sam moved in". Editing left_on is exactly
// the operation that makes post-departure expenses stop affecting a member.
// ============================================================================
import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { requireAuth, requireGroupAccess } from '../auth/middleware.js';

export const membersRouter = Router({ mergeParams: true });
membersRouter.use(requireAuth, requireGroupAccess);

membersRouter.get('/', async (req, res) => {
  const members = await query(
    `SELECT id, name, member_type, joined_on::text, left_on::text, user_id
     FROM members WHERE group_id = $1 ORDER BY member_type, name`,
    [req.group.id]
  );
  res.json(members);
});

membersRouter.post('/', async (req, res) => {
  const { name, memberType = 'resident', joinedOn = null, leftOn = null } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const m = await queryOne(
      `INSERT INTO members (group_id, name, member_type, joined_on, left_on)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, member_type, joined_on::text, left_on::text`,
      [req.group.id, name, memberType, joinedOn, leftOn]
    );
    res.status(201).json(m);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A member with that name already exists' });
    throw e;
  }
});

// Update a member — typically to set left_on (someone moves out) or joined_on.
membersRouter.patch('/:memberId', async (req, res) => {
  const { name, memberType, joinedOn, leftOn } = req.body || {};
  const m = await queryOne(
    `UPDATE members SET
       name        = COALESCE($3, name),
       member_type = COALESCE($4, member_type),
       joined_on   = COALESCE($5, joined_on),
       left_on     = $6
     WHERE id = $1 AND group_id = $2
     RETURNING id, name, member_type, joined_on::text, left_on::text`,
    [Number(req.params.memberId), req.group.id, name ?? null, memberType ?? null,
     joinedOn ?? null, leftOn ?? null]
  );
  if (!m) return res.status(404).json({ error: 'Member not found' });
  res.json(m);
});
