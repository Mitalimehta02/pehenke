# PehenKe

**See it on you before you buy.** A try-on assistant for small Indian clothing sellers who sell
over chat: a buyer sends one photo and sees the seller's outfit on themselves, and that try-on
becomes the order confirmation card, to cut cash-on-delivery refusals.

Built for the YouCam API Skin AI & eCommerce VTO Hackathon. Web chat demo now; WhatsApp next.

## What's here

- `/chat/[sellerSlug]` — phone-style buyer chat (consent, photo, try-on, preview, order)
- `/seller/[slug]` — seller view: add outfits (photo gate), approve order cards, outcomes, funnel
- `/credits` — sources and licences of the demo images
- `lib/engine` — channel-agnostic conversation engine (`handle(message) -> messages`)
- `lib/tryon` — YouCam try-on jobs: content-hash cache, caps, resume after restart
- `SPIKE.md` — what the YouCam API spike found; `DEPLOY.md` — how to deploy

## Run locally

```bash
npm install
cp .env.example .env      # fill in YOUCAM_API_KEY etc. (never commit .env)
npm run dev:local         # local Postgres-in-process + fake renderer: no database, no units
npm test                  # unit tests (no network, no units)
```

With a real database: `npm run db:migrate`, `npm run db:seed`, then `npm run dev`.

## Licence

Code: [MIT](LICENSE). Demo images are **not** part of this repository and are not covered by the
MIT licence; each keeps its own licence (CC0, CC BY, CC BY-SA, public domain), listed in
`spike-assets/SOURCES.md` and on the `/credits` page.
