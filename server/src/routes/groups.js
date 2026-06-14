// ============================================================================
// routes/groups.js — create groups, list groups, fetch one group with members.
// ============================================================================
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { requireAuth, requireGroupAccess } from '../auth/middleware.js';
import { setupDefaultGroup } from '../import/setupGroup.js';

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

// Create an empty group (you become its admin).
groupsRouter.post('/', async (req, res) => {
  const { name, baseCurrency = 'INR' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const group = await withTransaction(async (client) => {
    const g = await client.query(
      `INSERT INTO groups (name, base_currency, created_by) VALUES ($1,$2,$3)
       RETURNING id, name, base_currency`,
      [name, baseCurrency, req.user.uid]
    );
    await client.query(
      `INSERT INTO group_users (group_id, user_id, role) VALUES ($1,$2,'admin')`,
      [g.rows[0].id, req.user.uid]
    );
    return g.rows[0];
  });
  res.status(201).json(group);
});

// Create the pre-seeded demo group ("Flat 4B" with the roster). Convenience so
// a fresh login can immediately import the CSV.
groupsRouter.post('/demo', async (req, res) => {
  const group = await withTransaction(async (client) => {
    const g = await setupDefaultGroup(client, { createdBy: req.user.uid });
    await client.query(
      `INSERT INTO group_users (group_id, user_id, role) VALUES ($1,$2,'admin')`,
      [g.id, req.user.uid]
    );
    return g;
  });
  res.status(201).json(group);
});

// List groups the user belongs to.
groupsRouter.get('/', async (req, res) => {
  const groups = await query(
    `SELECT g.id, g.name, g.base_currency, gu.role
     FROM groups g JOIN group_users gu ON gu.group_id = g.id
     WHERE gu.user_id = $1 ORDER BY g.id`,
    [req.user.uid]
  );
  res.json(groups);
});

// One group + its members.
groupsRouter.get('/:groupId', requireGroupAccess, async (req, res) => {
  const members = await query(
    `SELECT id, name, member_type, joined_on::text, left_on::text, user_id
     FROM members WHERE group_id = $1 ORDER BY member_type, name`,
    [req.group.id]
  );
  res.json({ group: req.group, members });
});
