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
