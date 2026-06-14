// ============================================================================
// api/index.js — Vercel serverless entry. Vercel routes /api/* to this file
// (see vercel.json). It reuses the exact same Express app as local dev.
// ============================================================================
import { createApp } from '../server/src/app.js';

const app = createApp();
export default app;
