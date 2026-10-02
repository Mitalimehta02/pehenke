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

## Stack

- Next.js 16 (App Router) + TypeScript, one project. Next 16 differs from
  older versions: read `node_modules/next/dist/docs/` before writing Next code.
- Postgres + Prisma 7. **Schema-only until the bot phase**: no database is
  provisioned; the datasource URL lives in `prisma.config.ts`, not the schema.
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
- `npm run spike:skintone -- --person <file>` — dry run; add `--yes` to spend
