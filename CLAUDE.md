@AGENTS.md

# PehenKe

WhatsApp bot for small Indian clothing sellers who have no website. A buyer
sends a selfie and gets a virtual try-on of the seller's garment. The try-on
image is reused as the order confirmation card ("this is what you ordered, on
you") to reduce cash-on-delivery refusals.

Built for the YouCam API Skin AI & eCommerce VTO Hackathon (deadline Nov 2).

Later phases: catalogue built from forwarded product posts, complete-the-look
(jewelry + lip shade), family vote, size step, consent and deletion.

**Current phase: setup + API spike.** The bot does not exist yet. Don't build
bot features unless asked.

**Out of scope: lower-body garments** (salwars, palazzos, skirts, jeans sold
on their own). YouCam needs worn photos for them, which sellers rarely post.
The spike planner skips any `lower_body` row; don't spend units on them.
Full-body garments (sarees, lehengas, kurta sets) stay in scope.

## Stack

- Next.js 16 (App Router) + TypeScript, one project. Next 16 differs from
  older versions: read `node_modules/next/dist/docs/` before writing Next code.
- Postgres (Neon) + Prisma 7. Two connection strings:
  - `DATABASE_URL`: **pooled** (`-pooler` host). App queries only, via
    `lib/db.ts` (Prisma 7 requires a driver adapter: `@prisma/adapter-pg`).
  - `DIRECT_URL`: **direct** (no `-pooler`). Prisma CLI only (migrate, db
    execute, studio), via `datasource.url` in `prisma.config.ts`. Prisma 7
    removed `directUrl`; this is its replacement.
  - The generated client lives in `lib/generated/prisma` (gitignored,
    `postinstall` runs `prisma generate`).
  - **The developer's home network blocks outbound port 5432** (the Neon host
    answers on 443 but 5432 times out). Database commands (migrate, db
    execute, local app runs that query the DB) need the phone hotspot or WARP.
    The deployed app is not affected.
- Hosted on a long-running Node host (not serverless): background polling and
  in-process work are fine.
- YouCam API, called **server-side only**.

## Architecture rules

- **Channel-agnostic conversation engine**: `message in -> messages out`. Web
  chat and WhatsApp are thin adapters added later; no channel-specific logic
  in the engine.
- **The YouCam key never reaches client code.** It is read only in
  `lib/env.ts`, which imports `server-only`. Never use a `NEXT_PUBLIC_` prefix
  for it, never log it, never print it.
- `lib/youcam/` is the only code that talks to YouCam. It is a plain typed
  client (no Next imports) so scripts and the server share it. Scripts run
  with `tsx --conditions=react-server` so `server-only` resolves.

## YouCam API: verified from the docs, not guessed

Source: https://yce.perfectcorp.com/document/index.html (embedded OpenAPI
spec). If something isn't in the spec, say so instead of guessing.

- Base URL `https://yce-api-01.makeupar.com`, header
  `Authorization: Bearer <API key>`. No token exchange in V2.
- Upload: `POST /s2s/v2.0/file/{feature}` -> `file_id` + pre-signed `PUT`
  URL; upload the bytes yourself. Uploads live 24h.
- Task: `POST /s2s/v2.0/task/{feature}` -> `task_id`; poll
  `GET /s2s/v2.0/task/{feature}/{task_id}` until `success` | `error`.
  Result URLs expire after 2h: download immediately.
- Try-on = feature `cloth-v3` (latest). Body: `src_file_id` (person),
  `ref_file_id` (garment), `garment_category`
  (`upper_body|lower_body|full_body|shoes|auto`, required), `change_shoes`.
- Skin tone = feature `skin-tone-analysis` (jpg only, face > 60% of width).
- Costs: `GET /s2s/v2.0/credit/feature-cost`. Balance:
  `GET /s2s/v1.0/client/credit` (documented with V1 auth; whether the V2 key
  works there must be checked live).
- Units are charged only on `success`, **but an un-polled task times out and
  still charges**, and its result is then unreachable (`InvalidTaskId`).
  Always persist `task_id` before polling and keep polling to completion.
- Never auto-retry `POST /task/*` on network errors or 5xx (it can create a
  second paid task). `429` is safe to retry. Rate limit: 5 QPS, 250 / 5 min.

### Known doc gaps and contradictions
- Task status responses carry no "units consumed" field: use the feature-cost
  table, cross-checked with balance deltas.
- `polling_interval` is mentioned in prose but not in any schema; we use our
  own backoff and honour the field if it ever appears.
- Person photo: guide says "full-body photo", spec table says "upper body
  only, chest up". The spike tests both framings.
- Lower-body references must be worn photos, not product shots.
- `content_type` "listed in the enum" but no enum is published; we send
  `image/jpg` / `image/png` as in the examples.
- Skin-tone guide prose says `face-attr-analysis`; spec paths are
  `skin-tone-analysis`. We follow the spec.
- Error code table includes codes absent from the enum (`error_invalid_ref`,
  `error_apply_region_mismatch`): treat task errors as open strings.
- Verified live: feature-cost rejects `starting_token=null` (400) although
  the docs say to start with `null`; omit it on the first page.
- Verified live: the balance endpoint accepts both the V2 API key and a V1
  token (secret key, RSA PKCS#1 v1.5). It returned `results: []` before
  units were credited, then real entries (ApiPaygToken grants with expiry).
  Treat an empty list as "unknown", never as 0. Per-call balance deltas
  matched the cost table exactly.
- Verified live costs: cloth-v3 = 2 units per result image;
  skin-tone-analysis = 20 units per result.
- Verified live: `change_shoes` defaults to true for full_body and
  lower_body, and footwear was swapped from the seller's photo. Send
  `change_shoes: false` (buyers don't order shoes).
- Verified live: `garment_category: auto` pulled extra items from worn and
  mannequin photos (leggings, mannequin neck). Always send an explicit
  category. Spike results and recommended scope: SPIKE.md.
- Verified live: **try-on output is repeatable and every repeat is charged.**
  The same person + garment rendered 5 times (3 on the same file IDs, 2 on
  freshly uploaded new file IDs) gave byte-identical images, and each call
  cost 2 units. So: the app must cache results by content hash (person
  image hash + garment image hash + category) and never re-request a render
  it already has. Re-rendering also can't "fix" a bad output; change an
  input instead (e.g. ask for a full-body photo).

- Verified live (complete-the-look spike, SPIKE.md): `makeup-vto`, `2d-vto/necklace` and
  `2d-vto/earring` cost 1 unit per success; errors and 400s were not charged. They fail on a
  full-body image and work on a head-and-shoulders crop; output is pixel-identical outside
  the effect. Makeup smooths skin at 50 by default: always send `skin_smooth` strength 0.
  Omit optional jewellery fields rather than sending `null` (400, although the docs' sample
  does). Jewellery photos are used as given: necklace in its worn U shape, one earring.
- Verified live: these features change odd image sizes (a 959x1199 crop came back 960x1198;
  960x1200 came back unchanged), which breaks pixel alignment. The look pipeline sends
  multiples of 16 and refuses to paste a result that differs across most of the crop.
- Lipstick: matte at intensity 50 paints closest to the requested colour (70 is bolder).

## Skin tone: expensive, call once per buyer

Skin tone analysis costs 20 units, 10x a try-on. Call it **at most once per
buyer**, on their first usable selfie, and cache the result (skin, lip,
eye, hair colours) against the buyer. Every later feature (lip shade,
jewellery, complete-the-look) reads the cached result; never re-analyse
the same buyer, and never call it speculatively or per message.

## Render audit (vision model)

`lib/audit/` checks each try-on output for things the buyer didn't order
(invented jewellery, accessories, garment pieces), wrong length, and changes
to face/hair/background. Pipeline code depends only on the `RenderAuditor`
interface (`auditRender(input) -> RenderAudit` JSON); providers are swapped
in `auditorFromEnv()`. If `GEMINI_API_KEY` is unset the audit is skipped.

- Provider: Gemini API **free tier**, model `gemini-3.8-flash` (stable,
  image input, free tier: checked in Google's docs 2026-10-01), via the
  Interactions API with `store=false`.
- **Gemini free-tier inputs may be used by Google to improve its products**
  (Google's pricing page: "Used to improve our products: Yes" for the free
  tier, "No" for paid). This provider is for **spike images only**. Real
  buyer photos need a paid tier, or explicit consent wording that covers
  this, before the pilot.
- Free-tier rate limits are not published per model (only visible per
  project in AI Studio). Seen live: **20 requests per day**, and ~55% of
  requests returned 503 "high demand". Run one audit at a time, back off on
  503/per-minute 429, fail fast on the daily 429. Not viable as the
  production audit on the free tier.

## Core phase layout (web mirror first; WhatsApp later)

- `lib/engine/`: channel-agnostic state machine, `handle(incoming) -> outgoing`; all
  buyer text in `copy.ts`, seller text in `sellerCopy.ts` (English now, Hindi later).
- `lib/tryon/service.ts`: render jobs. Cache by inputs hash, caps checked first, task id
  persisted before polling, resume on server start (`instrumentation.ts`).
- `lib/gate/`: seller photo gate, once per garment photo; Gemini via RenderAuditor within
  GEMINI_DAILY_LIMIT, else "needs your check" (seller checklist).
- `lib/consent/`: consent, "delete my photos" (here and at YouCam via task delete),
  30-day retention purge.
- `lib/storage/blobs.ts`: image bytes only in the Blob table (Postgres for now, behind
  BlobStore). Nothing may depend on local disk (Render wipes it).
- Order cards are never auto-sent: the seller approves each one. Approval makes a
  `/card/<token>` link and one card image (`lib/orders/cardImage.ts`, bundled Noto Sans);
  the seller sends it via a wa.me link. The buyer's WhatsApp number (asked at order time,
  optional) lives only on the Order and is masked in chat history.
- Family vote (`lib/family/`): public `/v/<token>`, 7 days, tally posted to the chat.
- "Delete my photos" and the 30-day purge also clear WhatsApp numbers, card links/images
  and family links. Changing the consent text means bumping `CONSENT_VERSION`.
- `lib/look/`: "complete the look" on a finished try-on. Free and local: face locator
  (`faceFinder.ts`, bundled pico cascade), head-and-shoulders crop, ear/forehead change
  check (earrings only when the try-on left them untouched), lip shades from the garment,
  paste-back of only the changed pixels. Paid: necklace -> earrings -> lipstick, 1 unit
  each, every step cached by hash (`LookStep`), task id saved before polling. The neck
  has no reliable automatic check: the buyer is shown the close-up and asked.
  An item the API refuses (free) is left out and the look continues; earrings drawn on
  one ear only are rejected by us (paid, recorded as wasted). Both are remembered on the
  step (`LookStep.rejection`) and never rendered again. No free check can tell whether an
  ear is visible, so earrings are offered as an attempt, not a promise. A left-out item
  can still be ordered without a picture (`OrderItem.shown = false`, "not shown" on the card).
- Deploys: `build:render` fails the build when pending migrations can't be applied
  (DEPLOY.md). `/api/health` reports ok / degraded (names and counts only).
- `lib/gate/accessoryGate.ts`: jewellery photo rules (one earring, pair -> crop to confirm;
  necklace in worn U shape; plain backdrop). `lib/accessories/`: seller jewellery.
- A look ordered with "Order this look" puts its jewellery on the order (`OrderItem`,
  `Order.lookItems`); the lip shade is always listed as a styling suggestion, not included.
- Tests run the real migrations on in-process PGlite (`lib/testing/db.ts`) with a fake
  YouCam (`lib/testing/fakeYoucam.ts`). No network, no units.

## Conventions

- **API budget**: 1,000 units total; the spike is hard-capped at 300
  (`SPIKE_UNIT_CAP`). Before any run that spends units, print the estimated
  cost and wait for explicit human confirmation. Never render the same
  (garment, person, category) twice: results are cached by content hash.
- Log units consumed on every API call.
- `.env.example` lists every variable; `.env` is gitignored.
- Small commits with clear messages.
- Spike photos of real people (`spike-assets/people`) and outputs
  (`spike-output/`) are gitignored.

## Commands

- `npm run dev` — Next dev server
- `npm test` — unit tests (vitest)
- `npm run spike:costs` — free: feature-cost table + balance check
- `npm run spike` — dry run: plan + cost estimate, spends nothing
- `npm run spike -- --yes` — real run (only after human approval)
- `npm run db:migrate` — apply migrations (prisma migrate deploy, uses DIRECT_URL; needs port 5432)
- `npm run db:seed` — idempotent demo data (demo seller, garments through the real photo gate, sample photos; credits from spike-assets/SOURCES.md). No units.
- `npm run dev:local` — local dev without Neon or units: LOCAL_PGLITE=1 (file-backed in-process Postgres in .pglite/) and YOUCAM_FAKE=1 (fake renderer that reuses real spike renders when available). Both flags are ignored in production.
- `npm run spike:skintone -- --person <file>` — dry run; add `--yes` to spend
- `npm run prerender:looks` — dry run: one look per cached sample render and its cost; `--yes` spends (only after approval)
- `npm run spike:gate` / `spike:lipshades` — free: jewellery photo gate / lip shade proposals on the spike images
- `npm run seller:create -- --name "Shop" [--slug x]` — real seller; prints the private seller link (once) and the buyer chat link. `--new-link <slug>` replaces a lost link. Same code as `/admin` (needs `ADMIN_SECRET`). No units.
- `npm run spike -- --repeat N ...` — repeatability: N extra renders per job,
  cached under their own keys (the only sanctioned cache bypass)
- `npm run spike:recheck` — free: re-run pixel guards (bad render, garment
  length) on cached outputs and rewrite results.csv
