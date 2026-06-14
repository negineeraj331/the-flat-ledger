// ============================================================================
// app.js — Express application wiring. Exported (not listened) so it can run
// both as a local server (index.js) and as a Vercel serverless function
// (../../api/index.js).
// ============================================================================
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';

import { authRouter } from './auth/routes.js';
import { groupsRouter } from './routes/groups.js';
import { membersRouter } from './routes/members.js';
import { expensesRouter } from './routes/expenses.js';
import { balancesRouter } from './routes/balances.js';
import { settlementsRouter } from './routes/settlements.js';
import { importsRouter } from './routes/imports.js';

export function createApp() {
  const app = express();

  // Allow the configured client origin and send cookies cross-site in prod.
  const origins = config.clientOrigin.split(',').map((s) => s.trim());
  app.use(cors({ origin: origins, credentials: true }));
  // CSV uploads can be a few hundred KB; bump the JSON limit.
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRouter);
  app.use('/api/groups', groupsRouter);
  // Nested under a group (mergeParams lets them read :groupId).
  app.use('/api/groups/:groupId/members', membersRouter);
  app.use('/api/groups/:groupId/expenses', expensesRouter);
  app.use('/api/groups/:groupId/balances', balancesRouter);
  app.use('/api/groups/:groupId/settlements', settlementsRouter);
  app.use('/api/groups/:groupId', importsRouter); // /imports + /anomalies

  // JSON 404 for unknown API routes.
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Centralised error handler so a thrown error becomes JSON, not an HTML stack.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}
