// ============================================================================
// index.js — local development entry point. Starts the HTTP listener.
// (In production on Vercel, ../../api/index.js wraps the same app instead.)
// ============================================================================
import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
