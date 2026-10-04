import { describe, expect, it } from "vitest";
import type { GarmentPhotoAudit, RenderAuditor } from "../audit/types";
import { GarmentService, isTryable } from "../garments/service";
import { PrismaBlobStore } from "../storage/blobs";
import { setupTestDb } from "../testing/db";
import { garmentImage } from "../testing/fixtures";
import { Ledger } from "../units/ledger";
import { GarmentGate } from "./garmentGate";
import sharp from "sharp";

const db = setupTestDb();

function auditor(result: GarmentPhotoAudit | Error, onCall?: () => void): RenderAuditor {
  return {
    name: "fake-vision",
    auditRender: async () => {
      throw new Error("unused");
    },
    auditGarmentPhoto: async () => {
      onCall?.();
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function setup(a?: RenderAuditor, geminiDailyLimit = 18) {
  const ledger = new Ledger(db.prisma, { youcamDailyUnits: 60, buyerDailyRenders: 6, geminiDailyLimit });
  const blobs = new PrismaBlobStore(db.prisma);
  const svc = new GarmentService({ prisma: db.prisma, blobs, gate: new GarmentGate({ auditor: a, ledger }) });
  const seller = await db.prisma.seller.create({ data: { slug: "s", name: "S", accessKeyHash: "x" } });
  return { svc, seller, ledger };
}

const base = async () => ({ bytes: await garmentImage(), label: "saree", category: "full_body" as const, photoType: "mannequin" as const });

describe("garment photo gate", () => {
  it("approves a clean photo and stores the result with the garment", async () => {
    const { svc, seller } = await setup(auditor({ acceptable: true, problems: [], seen: "saree on a mannequin" }));
    const g = await svc.add(seller.id, await base());
    expect(g).toMatchObject({ gateStatus: "approved", gateBy: "fake-vision", gateAdvice: null });
    expect(isTryable(g)).toBe(true);
  });

  it("rejects with exact advice for each problem", async () => {
    const { svc, seller } = await setup(auditor({ acceptable: false, problems: ["glass_or_reflection", "cropped"], seen: "coat behind glass" }));
    const g = await svc.add(seller.id, await base());
    expect(g.gateStatus).toBe("rejected");
    expect(g.gateProblems).toEqual(["glass_or_reflection", "cropped"]);
    expect(g.gateAdvice).toMatch(/without glass.*whole item fits.*mannequin or hanger against a plain wall/);
    expect(isTryable(g)).toBe(false);
  });

  it("falls back to 'needs your check' without a vision provider; the checklist publishes it", async () => {
    const { svc, seller } = await setup(undefined);
    const g = await svc.add(seller.id, await base());
    expect(g).toMatchObject({ gateStatus: "needs_review", gateBy: "rules", sellerConfirmed: false });
    expect(isTryable(g)).toBe(false);
    expect(isTryable(await svc.confirmChecklist(seller.id, g.id))).toBe(true);
  });

  it("falls back when the vision check fails (e.g. 503 after retries)", async () => {
    const { svc, seller } = await setup(auditor(new Error("503 high demand")));
    expect((await svc.add(seller.id, await base())).gateStatus).toBe("needs_review");
  });

  it("respects the daily Gemini budget and doesn't call the provider when it's used up", async () => {
    let calls = 0;
    const { svc, seller, ledger } = await setup(auditor({ acceptable: true, problems: [], seen: "x" }, () => calls++), 1);
    ledger.logGemini("interactions", 200);
    expect((await svc.add(seller.id, await base())).gateStatus).toBe("needs_review");
    expect(calls).toBe(0);
  });

  it("rejects photos below YouCam's minimum by rule, without the provider", async () => {
    let calls = 0;
    const { svc, seller } = await setup(auditor({ acceptable: true, problems: [], seen: "x" }, () => calls++));
    const tiny = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#a33" } }).jpeg().toBuffer();
    expect(await svc.add(seller.id, { ...(await base()), bytes: tiny })).toMatchObject({ gateStatus: "rejected", gateProblems: ["too_small"] });
    expect(calls).toBe(0);
  });

  it("refuses the same photo twice for one seller", async () => {
    const { svc, seller } = await setup(undefined);
    const b = await base();
    await svc.add(seller.id, b);
    await expect(svc.add(seller.id, b)).rejects.toThrow(/already used/);
  });
});
