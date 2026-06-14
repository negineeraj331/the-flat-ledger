// ============================================================================
// config.js — centralised environment config. Fail loud if something critical
// is missing rather than crashing deep inside a query.
// ============================================================================
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 4000,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  // Comma-separated list of allowed browser origins for CORS in production.
  // In dev we allow the Vite origin by default.
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  isProd: process.env.NODE_ENV === 'production',
};

if (!config.databaseUrl) {
  console.warn(
    '[config] DATABASE_URL is not set. Copy server/.env.example to server/.env ' +
      'and point it at your Postgres/Neon instance.'
  );
}
