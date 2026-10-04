import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GarmentCategory } from "@/lib/youcam";
import { GARMENT_LENGTHS, defaultLength, type GarmentLength } from "@/lib/guards/length";
import { GARMENTS_CSV, GARMENTS_DIR, PEOPLE_DIR, sha256, type Framing, type PhotoType, type SkinToneJob, type TryOnJob } from "./store";

export interface Garment {
  file: string;
  label: string;
  category: Exclude<GarmentCategory, "auto">;
  photoType: PhotoType;
  /** expected hem length; optional 5th CSV column, else derived from the label */
  length?: GarmentLength;
}

export interface Person {
  file: string;
  person: string;
  framing: Framing;
}

const CATEGORIES = ["upper_body", "lower_body", "full_body", "shoes"] as const;
const PHOTO_TYPES = ["flatlay", "hanger", "mannequin", "worn"] as const;
const IMAGE_EXT = /\.(jpe?g|png)$/i;

export function loadGarments(): Garment[] {
  if (!existsSync(GARMENTS_CSV)) throw new Error(`Missing ${path.relative(process.cwd(), GARMENTS_CSV)} (columns: file,label,category,photo_type[,length])`);
  const lines = readFileSync(GARMENTS_CSV, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const header = lines.shift()?.split(",").map((h) => h.trim().toLowerCase());
  const h = header?.join(",");
  if (h !== "file,label,category,photo_type" && h !== "file,label,category,photo_type,length") {
    throw new Error(`garments.csv header must be: file,label,category,photo_type[,length] (got: ${h})`);
  }
  const errors: string[] = [];
  const garments = lines.map((line, i) => {
    const [file, label, category, photoType, length] = line.split(",").map((c) => c.trim());
    const where = `garments.csv line ${i + 2}`;
    if (!file || !label) errors.push(`${where}: file and label are required`);
    if (!CATEGORIES.includes(category as never)) errors.push(`${where}: category must be one of ${CATEGORIES.join("|")} (got "${category}")`);
    if (!PHOTO_TYPES.includes(photoType as never)) errors.push(`${where}: photo_type must be one of ${PHOTO_TYPES.join("|")} (got "${photoType}")`);
    if (length && !GARMENT_LENGTHS.includes(length as GarmentLength)) errors.push(`${where}: length must be one of ${GARMENT_LENGTHS.join("|")} (got "${length}")`);
    if (file && !existsSync(path.join(GARMENTS_DIR, file))) errors.push(`${where}: ${file} not found in spike-assets/garments`);
    return { file, label, category, photoType, length: (length || undefined) as GarmentLength | undefined } as Garment;
  });
  if (errors.length) throw new Error(errors.join("\n"));

  const listed = new Set(garments.map((g) => g.file));
  const unlisted = readdirSync(GARMENTS_DIR).filter((f) => IMAGE_EXT.test(f) && !listed.has(f));
  if (unlisted.length) console.warn(`! not in garments.csv, ignored: ${unlisted.join(", ")}`);
  return garments;
}

export function loadPeople(): Person[] {
  if (!existsSync(PEOPLE_DIR)) return [];
  return readdirSync(PEOPLE_DIR)
    .filter((f) => IMAGE_EXT.test(f))
    .map((file) => {
      const m = /^(.+)-(full|chest)\.(jpe?g|png)$/i.exec(file);
      if (!m) console.warn(`! ${file}: expected <name>-full.jpg or <name>-chest.jpg; framing recorded as "unknown"`);
      return { file, person: m ? m[1] : file.replace(IMAGE_EXT, ""), framing: (m ? m[2].toLowerCase() : "unknown") as Framing };
    });
}

const fileHash = (dir: string, file: string) => sha256(readFileSync(path.join(dir, file)));

export interface PlanFilters {
  garments?: string[];
  people?: string[];
  framings?: Framing[];
  /** send this category instead of the labelled one (the "auto" comparison) */
  categoryOverride?: GarmentCategory;
  /**
   * Repeatability test: also plan N extra renders of each job, cached under
   * their own keys (repeat 1..N), so the original cached result isn't reused.
   */
  repeat?: number;
  /**
   * With repeat: upload the files again for every render (new file IDs), to
   * tell a deterministic model from a stored result. Plans repeats 1..N only.
   */
  freshUpload?: boolean;
}

export interface Plan {
  jobs: TryOnJob[];
  skipped: Array<{ what: string; reason: string }>;
}

export function planTryOns(garments: Garment[], people: Person[], f: PlanFilters): Plan {
  const skipped: Plan["skipped"] = [];
  const unknownG = (f.garments ?? []).filter((g) => !garments.some((x) => x.file === g));
  const unknownP = (f.people ?? []).filter((p) => !people.some((x) => x.person === p));
  if (unknownG.length || unknownP.length) {
    throw new Error(`Unknown ${[...unknownG.map((g) => `garment "${g}"`), ...unknownP.map((p) => `person "${p}"`)].join(", ")}`);
  }

  const gs = garments.filter((g) => !f.garments || f.garments.includes(g.file));
  const ps = people.filter((p) => (!f.people || f.people.includes(p.person)) && (!f.framings || f.framings.includes(p.framing)));

  const jobs: TryOnJob[] = [];
  for (const g of gs) {
    // Lower-body garments are out of scope (see CLAUDE.md): never spend units on them.
    if (g.category === "lower_body") {
      skipped.push({ what: g.file, reason: "lower_body is out of scope" });
      continue;
    }
    const garmentHash = fileHash(GARMENTS_DIR, g.file);
    for (const p of ps) {
      const personHash = fileHash(PEOPLE_DIR, p.file);
      const category = f.categoryOverride ?? g.category;
      for (let repeat = f.freshUpload ? 1 : 0; repeat <= (f.repeat ?? 0); repeat++) {
        // repeat 0 keeps the original key, so earlier results stay cached
        const keyParts = [
          "tryon",
          "cloth-v3",
          category,
          garmentHash,
          personHash,
          ...(repeat ? [`repeat:${repeat}`] : []),
          ...(f.freshUpload ? ["fresh-upload"] : []),
        ];
        jobs.push({
          kind: "tryon",
          key: sha256(keyParts.join("|")),
          garmentFile: g.file,
          garmentHash,
          label: g.label,
          labelCategory: g.category,
          category,
          photoType: g.photoType,
          expectedLength: g.length ?? defaultLength(g.label),
          personFile: p.file,
          personHash,
          person: p.person,
          framing: p.framing,
          ...(repeat ? { repeat } : {}),
          ...(f.freshUpload ? { freshUpload: true } : {}),
        });
      }
    }
  }
  return { jobs, skipped };
}

export function planSkinTone(personFile: string): SkinToneJob {
  const people = loadPeople();
  const p = people.find((x) => x.file === personFile);
  if (!p) throw new Error(`${personFile} not found in spike-assets/people`);
  const personHash = fileHash(PEOPLE_DIR, p.file);
  return {
    kind: "skintone",
    key: sha256(["skintone", "skin-tone-analysis", personHash].join("|")),
    personFile: p.file,
    personHash,
    person: p.person,
    framing: p.framing,
  };
}
