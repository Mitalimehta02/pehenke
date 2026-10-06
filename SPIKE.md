# PehenKe: YouCam try-on spike results

Spike run 2026-10-02 to 2026-10-04 against YouCam **AI Clothes V3**
(`cloth-v3`), with a Gemini free-tier render audit and our own pixel checks.
The raw data is in `spike-output/results.csv`, with side-by-side comparisons
in `spike-output/compare/`. Both folders are gitignored.

> **Main untested risk: every test image is a stock, museum or Commons
> photo, not a real seller or buyer photo.** The garment photos are museum
> pieces, catalogue shots and Commons uploads; the three "buyers" are
> Commons portraits, two of them professional photos. Real WhatsApp seller
> posts (dim, cluttered, watermarked, collages, partly folded) and real
> buyer selfies (arm's length, mirror shots, cropped feet) have not been
> tried. Every success rate below may be optimistic until that is tested.

## What was tested

- **Renders:** 26 in total, 22 unique plus 4 deliberate repeats.
  - 15 garments: choli, kurti ×3, kurta, dupatta set, lehenga ×3, saree ×3, men's kurta ×2, sherwani.
  - 4 photo types: flat-lay, hanger, mannequin, worn.
  - 3 people, all full body: model1 (slim woman, light-brown skin, plus a chest-up crop), model2 (athletic man), model3 (slim woman, darker skin, busy night background).
- **Category:** explicit labels for the main runs, plus 3 runs with `garment_category: auto`.
- **Sources:** every image and its licence is listed in `spike-assets/SOURCES.md`. Three kurti photos are marked spike-only.
- **Lower-body garments:** out of scope and not tested.

## Headline numbers

| | |
|---|---|
| API success | **26 / 26** (no task errors, no timeouts, no lost tasks) |
| Units per render | **2**. The cost table says 2, and every render's balance delta was exactly 2. Charged only on success. |
| Render latency | **median 16.1 s** (min 11.0, max 88.6), from task start to result. The audit adds 5–75 s on top. |
| Repeatability | The same inputs give **byte-identical** output: 5 renders, 3 on the same file IDs and 2 on freshly uploaded ones. Every repeat is still charged. |
| Units spent | **52** (26 renders × 2). Skin tone: 0 (not run). |
| Units left | Account balance **988** (1,040 before the first paid run). Spike cap: 248 of 300 left. Run-2 cap: 16 of 68 unused. |

## Results by photo type

This decides what the bot tells sellers to send. The verdicts are from **my
visual review** applying the agreed card rules (see "Verdicts" for why not
the pipeline's own). Repeats and `auto` runs are excluded; n = 19.

| Photo type | n | send | disclose | block | What happened |
|---|---|---|---|---|---|
| **mannequin** | 4 | 2 | 2 | 0 | Best fidelity: the full outfit shape transfers cleanly (museum ghagra on two people, shop lehenga, museum saree). Problems are small: invented choker (saree), footwear swapped (shop lehenga). |
| **worn** | 7 | 3 | 3 | 1 | Garments transfer well, but **things leak from the model in the photo**: a bag and a broken sleeve (yellow kurti, blocked), maang tikka (lehenga), Nehru vest and mojaris (men's kurta). The model's skin tone did **not** leak (green kurti on model3). |
| **flatlay** | 4 | 0 | 4 | 0 | The unstitched saree drapes convincingly but always gets an invented blouse. A folded men's kurta pajama on a bed came out only partly right (an invented stole, unclear construction). |
| **hanger** | 4 | 2 | 0 | 2 | Mixed. The choli was fine chest-up but rendered tunic-length on the full body (block). A saree hung flat drapes stiffly but acceptably. A sherwani photographed behind glass came out as a **short-sleeved shirt** (block). |

## Results by garment type

My visual review again; labelled categories only.

| Garment | n | send | disclose | block | Notes |
|---|---|---|---|---|---|
| saree | 5 | 1 | 4 | 0 | Drapes like a saree, not pasted-on fabric: pleats and pallu over the shoulder. Almost always an **invented blouse** (colour depends on the input photo), sometimes **invented jewellery**. |
| lehenga | 4 | 2 | 2 | 0 | Strongest category: mannequin and worn photos both work, on both women. |
| kurti / kurta | 4 | 3 | 0 | 1 | Clean when the reference is a plain worn shot. The one with a bag in hand broke. |
| dupatta set | 1 | 0 | 1 | 0 | Kurta, salwar and dupatta all transferred; footwear swapped. |
| choli | 2 | 1 | 0 | 1 | Chest-up fine; full body rendered tunic-length. |
| men's kurta | 2 | 0 | 2 | 0 | Usable but weaker: the vest and shoes leaked from the worn photo, the kurta lost its sleeves, and the flat-lay invented a stole. |
| sherwani | 1 | 0 | 0 | 1 | Wrong garment from a poor photo (glass reflections, hem cut off). |

**Framing (run 1, model1):** both chest-up and full-body photos work for
upper-body garments. For full-body garments (saree, lehenga), use a
**full-body photo**: chest-up only shows the top of the drape, and the
chest-up saree got an invented pearl necklace that full-body renders didn't.

## The man and model3 compared with model1

- **model3** (darker skin, busy outdoor night background, dress): as good as model1. Her skin tone, face, braids, pose and background were kept. The green kurti, ghagra and saree all transferred well, and the saree still got an invented blouse. A busy background did not hurt.
- **model2** (man, walking pose, outdoor background): the renders succeeded and kept his face and pose. Quality was lower, but because of the **garment photos**, not the person: the worn men's kurta brought its vest and shoes along and lost its sleeves, the flat-lay was ambiguous, and the sherwani photo was deliberately poor. There isn't enough data to say men's garments are worse in general; the men's photos were the weakest inputs.
- **Identity:** face and hair were unchanged in every render I checked. One exception: the `auto` ghagra run changed model1's pose (arms down instead of hands on hips).

## `auto` category vs my labels

| Garment | My label | `auto` result |
|---|---|---|
| museum saree (mannequin) | full_body | **Matched**: byte-identical to the labelled render. |
| museum ghagra (mannequin) | full_body | Different image. Full outfit, correct, but the mannequin's **black neck form leaked** as a collar and the **pose changed**. |
| red kurti (worn) | upper_body | **Did not match**: it treated the photo as a full outfit and swapped the buyer's pink leggings for the model's **black leggings**. |

`auto` agreed with my label in 1 of 3 cases, and in both disagreements it pulled
in more of the reference photo than the seller is selling. **Use explicit
categories**: ask the seller "top only, or the full outfit?" once per product.

## Verdicts (send / disclose / block)

Two sets of numbers, because the Gemini audit was unavailable for 18 of the
22 unique renders (see "Gemini reliability").

| | send | send with disclosure | block |
|---|---|---|---|
| **Pipeline as built** (pixel checks + audit where available) | 2 | 19 | 1 |
| **My visual review** applying the same rules | 7 | 12 | 3 |

Where the pipeline got it wrong:
- **Bad renders it would have sent** (with only the generic disclosure):
  - the yellow kurti with the leaked bag and broken sleeve
  - the sherwani rendered as a shirt
  - the tunic-length choli. Its length flag was found to rest on a single image row, and is now reported as "unknown".

  The audit would probably have caught the first two (it did catch the invented necklace and blouses); it **missed the long choli**.
- **Good render it would have blocked:** the shop lehenga. The length check misread the hem (0.74 against floor length).
- **Conservative but harmless:** several clean renders got the generic disclosure because no audit was available.
- **My labelling mistake:** I first labelled the red kurti "hip" length; it's knee length. That produced a false block, now corrected in `garments.csv`.

**Pixel checks are not reliable enough to decide alone.** The bad-render check
never fired: no output returned the original clothes. The length check only
finds the garment when its colours survive the render (5 of 13 full-body
outputs), and has given both a false block and a miss. Treat pixel checks as
weak signals; a working vision audit (or human review) is required before
cards go to buyers.

## Flaws found

1. **Invented companion pieces:** a blouse with every saree, its colour depending on the input photo.
2. **Invented jewellery:** pearl necklace (chest-up saree), silver choker (museum saree).
3. **Leaks from the model or mannequin in the seller's photo:** bag, maang tikka, Nehru vest, mojaris, black leggings (`auto`), the mannequin's neck form (`auto`). No face or skin-tone leak was seen.
4. **Footwear swapped:** YouCam's `change_shoes` defaults to `true` for full-body garments, and shoes changed on the dupatta set, the shop lehenga and the men's kurta. **Send `change_shoes: false`**: buyers don't order shoes.
5. **Wrong construction:** the choli came out tunic-length, the men's kurta lost its sleeves, the sherwani became a shirt.
6. **Repeat renders are identical and still charged.** Re-rendering can't fix a bad output; change an input instead.
7. **Doc gaps hit live:** the feature-cost paging rejects the documented `null` start token; the balance endpoint returned `[]` before units were credited.

## Gemini reliability (render audit)

- **Model:** `gemini-3.8-flash`, free tier, Interactions API with `store=false`.
- **Before the quota ran out:** 22 requests for 9 audit jobs. **8 audits succeeded**, 1 failed after 5 attempts and then succeeded on a later retry.
  - **12 of the 22 requests (55%) returned 503** "model is experiencing high demand".
  - 2 returned 429.
- **Daily limit:** then the free tier answered **"limit: 20 requests per day"**, a figure Google's docs don't publish. That stopped all 18 run-2 audits. Failed requests appear to count toward the 20.
  - The audit now fails fast on that error instead of backing off.
- **Quality when it worked:** it caught the invented necklace and blouses, kept face and hair checks accurate, and missed the tunic-length choli.
- **Verdict:** usable for spot checks, **not usable as the production audit on the free tier.** 20 requests a day covers about 10 renders on a good day. The free tier also lets Google use the inputs (see CLAUDE.md). A paid tier or another provider is needed before the pilot.

## Recommended scope

**Accept**:
- **Sarees, lehengas/ghagras, kurtis/kurtas and dupatta sets** as the main categories, always with an **explicit category** chosen by the seller (top only vs full outfit), never `auto`.
- Garment photos on a **mannequin**, or a **plain worn photo** where the model holds nothing and wears no extra layers.
- Sarees as an unstitched **flat-lay** or a mannequin drape, with the card saying "blouse is illustrative" unless the seller's photo includes the blouse.
- Always send `change_shoes: false`.

**Refuse, or ask for a better photo**, for:
- photos behind glass or with reflections
- garments cut off at the frame edge
- folded garments
- worn photos where the model holds a bag or wears a jacket, vest or dupatta over the item

Say to the seller: *"Send one photo of the item on a mannequin or hanger against a plain wall, the whole item visible, nothing else in the picture."*

**Treat as experimental:**
- **Men's garments:** only weak inputs were tested.
- **Cholis and blouses:** they drift in length on a full-body photo.

**Out of scope:** lower-body garments sold on their own.

**Ask the buyer for** a full-body photo, standing, facing the camera; a chest-up photo is fine only for tops. Every card is gated by a working vision audit (or human review) plus the disclosure line, because pixel checks alone sent two clearly wrong renders.

## Open questions

- **Real photos:** run 10–20 **real seller photos and real buyer selfies** before any pilot (the main untested risk).
- **Audit provider:** choose one for the pilot (Gemini paid tier, or another vision model), then re-audit all 22 renders to measure catch rate against my visual review.
- **Leaked body shape:** the audit reports it but it doesn't affect the verdict. Should it?
- **Garment length:** should the expected hem length be a required seller input, with the pixel check dropped in favour of the audit?

## Complete-the-look spike (lipstick, necklace, earrings)

Run 2026-10-06 with `npm run spike:look`. 8 units spent (balance 968 -> 960), read
before and after every call. Base image: the cached demo render of Sample model B in
the ivory saree (1280x1600); "crop" = its head-and-shoulders box (480x600) upscaled x2.

| Call | Feature | Buyer image | Product | Result | Units |
|---|---|---|---|---|---|
| L1 | makeup-vto | full-body output | hex, matte | error `error_no_face` | 0 |
| L2 | makeup-vto | crop | hex, matte | success | 1 |
| L3 | makeup-vto | chest-up photo | hex, matte | success | 1 |
| N1 | 2d-vto/necklace | full-body output | U-shape photo | error "face alignment failed" | 0 |
| N2 | 2d-vto/necklace | crop | U-shape photo | success | 1 |
| N3 | 2d-vto/necklace | crop | coiled flat-lay photo | success, but drawn in its coiled shape (unusable) | 1 |
| C1 | makeup-vto | N2's result | hex, matte | success (necklace + lipstick) | 1 |
| E1 | 2d-vto/earring | front-facing crop | one earring | success, both ears | 1 |
| E2 | 2d-vto/earring | side-turned close-up | one earring | success | 1 |
| E3 | 2d-vto/earring | side-turned close-up | pair on a shop card | success, but a tiny fragment (unusable) | 1 |

Findings:
- **Failed calls were not charged**, for all three features: task errors (L1, N1) and
  request rejections (seven 400s) cost 0.
- **None works on the full-body image as-is; lipstick, necklace and earrings all work on
  a head-and-shoulders crop of our own output.** The docs say earrings need a side view
  of one ear; live, a front-facing crop got an earring on both ears for 1 unit.
- **Results are pixel-identical to the input outside the effect** (PNG, same size), so a
  crop result can be pasted back into the full-body image. With smoothing strength 0,
  nothing outside the lips changed.
- **Jewellery uses the seller's photo as given; it is not reshaped.** A necklace must be
  photographed in its worn U shape; a coiled flat-lay is drawn coiled. An earring photo
  must show one earring; from a pair on a card the engine picked a fragment.
- The optional `*_anchor_point`, `*_wearing_location` and `earring_scale` fields must be
  omitted: `null` (as in the docs' own sample request) is a 400 InvalidParameters.
- Detail is limited by the full-body frame: the face is about 130 px wide and the
  necklace about 100 px at original size. It reads as soft, not as artificial.
- Lip shades come from `lib/look/lipShade.ts` (garment colours -> two shades, free).
  Matte at intensity 70 rendered a bolder red than the proposed hex suggests.

Not tested: a necklace on a bust stand, hair covering the ears, earring size (`earring_scale`),
a real phone photo.

### Follow-up while building (2026-10-06, 3 more units)

- **Lipstick intensity.** Matte at 30 / 40 / 50 on the pipeline's own crop of the demo base
  (1 unit each): painted colour #b7716d / #a75751 / #99433c against the proposed #b63420.
  50 is the closest and reads as a natural lipstick; the spike's 70 was bolder. The app uses 50.
- **Odd image sizes are changed by the API.** A 959x1199 crop came back as 960x1198, so
  the result no longer lined up pixel for pixel with what was sent (the spike's 960x1200
  came back unchanged). The pipeline now sends sizes that are multiples of 16 and refuses
  to paste back a result that differs across more than 40% of the crop.
- **Finding the crop.** A free local face locator (pico, MIT) found exactly one face on all
  ten cached demo renders and none on a mannequin; its crop for the demo base landed within
  8 px of the one picked by hand in the spike.
- **Invented jewellery.** Comparing a render with the buyer's own photo is reliable around
  the ears and forehead (clean renders 0-2% changed; a drawn forehead ornament or a dupatta
  over the ear 8-41%), not at the neck (44-76% always, because the new neckline is there).
  So earrings are offered only when the head is untouched, and for a necklace the buyer is
  asked whether their neck is bare in the close-up.

### Demo look pre-render on live (2026-10-06, 7 units)

Planned 17 units for 8 sample renders; 7 were charged, 10 planned steps failed for free.

- Sample model B: ivory saree (necklace + earrings + lip, 3 units) and ghagra (earrings + lip,
  2 units) are good. The kurti (2 units) drew an earring on one ear only: dropped from the demo.
- Sample model A, all four renders: earrings refused with "earlobe alignment not confident"
  (her hair covers her ears). Free. Our own ear check passed these, because it only tests
  whether the try-on changed the ear area, not whether an ear is visible.
- Both lehenga renders: necklace refused with "Neck roll check failed". Free.
- A failed step currently fails the whole look, so those renders have no look at all,
  not even the lip shade.
- The database connection dropped mid-run. Nothing was lost: the one paid step in flight had
  its task id saved and was fetched on resume without a second charge.
- Fill-in the same day (5 units): a lip-shade-only look for the five renders left without one.
  All five succeeded. The demo then had 7 pre-rendered looks (2 with jewellery, 5 lip-only)
  for 12 units in total, against a first plan of 17.
