# Background jobs

Phase 1 has no scheduler running. This directory is where recurring work will
live in Phase 2+ (company-data sync, website scanning, email verification,
follow-up reminder digests, lead re-scoring sweeps).

Each job should export `{ name, schedule, run }` and be registered by a scheduler
(node-cron / BullMQ) wired up in `server.js`. Jobs must be idempotent and safe to
run concurrently with the API.

See `followUpReminders.js` for the shape.
