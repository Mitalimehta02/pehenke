# Deploying PehenKe (Render web service)

Not deployed yet. This is what the host needs and what to watch for.

## Host settings

| Setting | Value |
|---|---|
| Runtime | Node **24** (`.node-version` = 24; `engines.node` = `>=22.12 <25`; Next 16 needs ≥ 20.9) |
| Build command | `npm ci && npm run build` (`postinstall` runs `prisma generate`; no database needed at build time) |
| Pre-deploy command | `npm run db:migrate` (`prisma migrate deploy`, uses `DIRECT_URL`) |
| Start command | `npm run start` (`next start`; listens on `$PORT`, which Render sets) |
| Instances | **exactly 1** (in-process job queue, conversation locks and Gemini pacing assume one server) |
| Health check path | `/` (static, no database) |

One-time, from a developer machine with the spike images (they are gitignored, so the host
cannot seed): `npm run db:migrate`, `npm run db:seed`, then `npm run prerender` (dry run) and
`npm run prerender -- --yes` after approving the cost. All need port 5432 (hotspot/WARP).

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `YOUCAM_API_KEY` | yes | server-only, never `NEXT_PUBLIC_` |
| `YOUCAM_SECRET_KEY` | no | V1 token auth for the balance endpoint (not used by the app) |
| `YOUCAM_BASE_URL` | no | default `https://yce-api-01.makeupar.com` |
| `DATABASE_URL` | yes | Neon **pooled** string (`-pooler` host), `sslmode=verify-full` |
| `DIRECT_URL` | yes (pre-deploy) | Neon **direct** string, for migrations |
| `YOUCAM_DAILY_UNIT_CAP` | no | default 60 |
| `BUYER_DAILY_RENDERS` | no | default 6 |
| `GEMINI_API_KEY` | no | photo gate; without it every new garment needs the seller's checklist |
| `GEMINI_MODEL` | no | default `gemini-3.8-flash` |
| `GEMINI_DAILY_LIMIT` | no | default 18 (free tier allows 20/day) |
| `DB_STORAGE_LIMIT_MB` | no | default 1024 (Neon free plan) |
| `LOCAL_PGLITE`, `YOUCAM_FAKE`, `SPIKE_UNIT_CAP` | **must not be set** | local development / spike only (ignored in production anyway) |

## A host that sleeps when idle and wipes its disk

**Safe by design**
- Nothing is stored on local disk: images live in Postgres (`Blob`), state in Postgres,
  buyer identity in a browser cookie. A wiped disk loses nothing.
- Paid renders survive a restart: the task id is written to the database before polling,
  and `instrumentation.ts` resumes running renders on every start.
- Caps, units and Gemini usage are counted in the database, so they survive restarts.
- Seller approvals and finished renders are stored as chat messages; a buyer who comes back
  later sees them.

**What can still go wrong**
1. **Render finishes while the server sleeps.** The buyer's chat polls every 2 s while a render
   runs, which keeps the server awake while the page is open. If the buyer closes it and the
   server sleeps, polling stops; on the next wake-up the render is resumed and the result
   appears in the chat. If nothing wakes the server for 24 h, YouCam's task retention runs out:
   the task still charges and is recorded as `lost`.
2. **Retention purge runs only while awake** (on start and hourly). After a long idle period
   the 30-day deletion happens late, on the next wake-up. The consent text promises 30 days,
   so for a pilot add a daily wake-up (an uptime ping or a cron job calling the site).
3. **Cold starts.** The first request after sleeping waits for the server to boot (resume and
   purge run in the background and don't block it, but the buyer still waits for start-up).
   During a live demo, open the site a minute before.
4. **Units logged just before a shutdown** can be lost: API-call log rows are written
   asynchronously. A render charged in the last instant before shutdown may be missing from
   the ledger, so the daily cap could under-count by a render or two.
5. **More than one instance breaks things:** two servers could render the same hash, double
   the Gemini pacing, and race on a conversation. Keep one instance.
6. **Seeding can't happen on the host** (spike images aren't in git). Seed from a developer
   machine once; the data then lives in Neon.
7. **Neon itself suspends idle compute** on the free plan; the first query after that is
   slower. Not an error, but it adds to cold-start time.
