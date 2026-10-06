# Deploying PehenKe on Render (free web service)

**Live:** https://pehenke.onrender.com · health: https://pehenke.onrender.com/api/health

Target: Render **Free** web service (512 MB RAM, sleeps after 15 min without inbound traffic,
~1 min to wake, no persistent disk), region **Ohio** (same as Neon us-east-2).
Facts below are from Render's docs (deploys, free, node-version, health-checks pages).

## Values to type into Render

| Field | Value |
|---|---|
| Build command | `npm ci && npm run build:render` |
| Start command | `npm run start` |
| Node version | from `.node-version` (= `24`); or set env `NODE_VERSION=24` |
| Health check path | `/api/health` |
| Instances | 1 (the free plan runs one) |

**Pre-deploy command: not available on Free** ("available for paid web services, private
services, and background workers"). So migrations run inside the build (`build:render`), and
**a build that can't apply them fails** (`scripts/migrate-if-configured.mjs`): it uses
`DIRECT_URL`, or derives the direct connection from `DATABASE_URL` (Neon: the pooled host
without `-pooler`); with neither, or if `prisma migrate deploy` fails, the build stops and
Render keeps the previous version, which still matches the database. The first lines of the
build log say which variables the build environment has (names only).
Why not migrate at server start: the new code would serve requests for a moment against the
old schema, a failed migration would crash-loop the server, and a free instance restarts often.
History: two releases went live with their migrations skipped (the old script only warned),
so ordering was broken on the live site until they were applied by hand on 2026-10-06.
`SKIP_BUILD_MIGRATIONS=1` switches the build step off on purpose (run `npm run db:migrate`
first). Migrations are forward-only; a migration that succeeds while the rest of the build
fails leaves the previous deploy running on the new schema, so keep migrations additive
(add columns/tables; remove things in a later release).

`/api/health` answers `"status": "ok"` or `"degraded"` with the reasons (names and counts
only): a required variable missing, the database unreachable, or migrations pending. It
returns HTTP 503 for a missing required variable or pending migrations (a deploy in that
state can't work), and 200 with `degraded` when the database is merely unreachable (it sleeps
when idle). It queries the database at most once an hour while healthy; `?fresh=1` forces it.

## Environment variable names (values go in the Render dashboard, never in git)

Required: `YOUCAM_API_KEY`, `DATABASE_URL` (Neon pooled), `DIRECT_URL` (Neon direct, migrations)

Recommended: `APP_URL` (`https://pehenke.onrender.com`; base of links sent on WhatsApp),
`ADMIN_SECRET` (16+ random characters; enables `/admin` to create sellers; unset = no `/admin`)

Optional: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_DAILY_LIMIT`, `YOUCAM_DAILY_UNIT_CAP`,
`BUYER_DAILY_RENDERS`, `BUYER_DAILY_LOOKS`, `DB_STORAGE_LIMIT_MB`, `YOUCAM_SECRET_KEY`, `YOUCAM_BASE_URL`,
`NODE_VERSION`, `NODE_OPTIONS` (recommended: `--max-old-space-size=384`)

**Do not set:** `NODE_ENV` (the build needs devDependencies such as `typescript` and the
`prisma` CLI; `next start` sets production mode itself), `LOCAL_PGLITE`, `YOUCAM_FAKE`,
`SPIKE_UNIT_CAP`.

## One-time setup (from a developer machine; needs port 5432, i.e. hotspot/WARP)

`npm run db:migrate`, `npm run db:seed`, `npm run prerender` (dry run), then
`npm run prerender -- --yes --max-units <n>` after approving the cost. Then, for the demo's
"Complete the look": `npm run prerender:looks` (dry run) and `-- --yes` after approving its cost. The demo images are
gitignored, so the host can't seed; after seeding, everything lives in Neon.

## Memory (512 MB)

Measured on a 12 MP (4000x3000) phone photo:
- Production server after loading every route: ~145 MB, peak ~185 MB.
- Image work per photo: ~65 MB with sharp's defaults, **~28 MB** after limiting sharp to one
  thread with no cache (`lib/storage/imageLimit.ts`).
- Image operations run **one at a time** app-wide, so concurrent uploads and finished renders
  don't stack. Expected peak ~215 MB: fits in 512 MB with headroom.
- Browsers already shrink photos to 2048 px before upload; full 12 MP files only arrive from
  direct API calls (capped at 15 MB).

## Sleeping host, wiped disk: what to expect

**Safe by design**
- Nothing on local disk: images in Postgres (`Blob`), state in Postgres, buyer id in a cookie.
- Paid renders survive restarts: task id saved before polling; resume on every start
  (`instrumentation.ts`, non-blocking). Verified live: a render interrupted by a database error
  was resumed without a new task or a second charge.
- Caps, units and Gemini usage are counted in the database.

**Keep it awake** with an external uptime monitor calling `https://<your-app>/api/health`
every 10 minutes. That also triggers the retention purge (at most hourly), which keeps the
"deleted after 30 days" promise. Render grants 750 free instance hours per workspace per month;
one always-on service uses ~744 h in a 31-day month, so this works for one free service only.

**What can still go wrong**
1. Without the keep-awake ping: a render still running when the server sleeps resumes on the next
   wake-up; if nothing wakes it for 24 h, YouCam's retention ends, the task still charges, and
   it's recorded as `lost`. The 30-day purge also runs late.
2. Cold start: ~1 min to wake (Render) plus Neon's compute waking. Open the site a minute before
   a live demo.
3. API-call log rows are written asynchronously; a charge logged in the instant before a
   shutdown can be lost, so the daily cap could under-count by a render.
4. One instance only: the job queue, conversation locks and Gemini pacing are in memory.
