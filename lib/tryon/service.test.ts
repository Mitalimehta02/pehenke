import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client";
import { PrismaBlobStore } from "../storage/blobs";
import { setupTestDb } from "../testing/db";
import { FakeYouCam } from "../testing/fakeYoucam";
import { addBuyerPhoto, seedBasics } from "../testing/fixtures";
import { Ledger } from "../units/ledger";
import { TryOnService } from "./service";

const db = setupTestDb();
let prisma: PrismaClient;
beforeEach(() => {
  prisma = db.prisma;
});

function setup(fake = new FakeYouCam(), caps = { youcamDailyUnits: 60, buyerDailyRenders: 6, geminiDailyLimit: 18 }) {
  const blobs = new PrismaBlobStore(prisma);
  const ledger = new Ledger(prisma, caps);
  const finished: string[] = [];
  const svc = new TryOnService({ prisma, blobs, ledger, youcam: (l) => fake.client(l), onFinished: async (id) => void finished.push(id) });
  return { blobs, ledger, svc, fake, finished };
}

describe("TryOnService", () => {
  it("renders once, stores the output, logs units, and serves the cache after", async () => {
    const { blobs, ledger, svc, fake, finished } = setup();
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const photo = await addBuyerPhoto(prisma, blobs, buyer.id);

    const r1 = await svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id });
    expect(r1.kind).toBe("started");
    await svc.idle();
    const t = await prisma.tryOn.findUniqueOrThrow({ where: { id: (r1 as { tryOn: { id: string } }).tryOn.id } });
    expect(t).toMatchObject({ status: "succeeded", units: 2, unitsWasted: 0, verdict: "send_with_disclosure", changeShoes: false, category: "full_body" });
    expect(await blobs.get(t.outputKey!)).not.toBeNull();
    expect(finished).toEqual([t.id]);
    // explicit category + change_shoes false sent to YouCam
    expect(fake.starts[0].body).toMatchObject({ garment_category: "full_body", change_shoes: false });
    expect(await ledger.youcamUnitsToday()).toBe(2);

    const r2 = await svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id });
    expect(r2.kind).toBe("cached");
    await svc.idle();
    expect(fake.starts).toHaveLength(1);
  });

  it("joins a render already in progress instead of starting a second", async () => {
    const { blobs, svc, fake } = setup(new FakeYouCam({ runningPolls: 3 }));
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const photo = await addBuyerPhoto(prisma, blobs, buyer.id);
    const [a, b] = await Promise.all([
      svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id }),
      svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["joined", "started"]);
    await svc.idle();
    expect(fake.starts).toHaveLength(1);
  });

  it("uploads fresh files for every render (task delete removes its inputs)", async () => {
    const { blobs, svc, fake } = setup();
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const p1 = await addBuyerPhoto(prisma, blobs, buyer.id, "#2b6cb0");
    const p2 = await addBuyerPhoto(prisma, blobs, buyer.id, "#22aa55");
    await svc.request({ garmentId: garment.id, buyerPhotoId: p1.id, buyerId: buyer.id });
    await svc.request({ garmentId: garment.id, buyerPhotoId: p2.id, buyerId: buyer.id });
    await svc.idle();
    const refs = fake.starts.map((s) => s.body.ref_file_id);
    expect(new Set(refs).size).toBe(2);
  });

  it("persists the task id before polling and resumes after a restart", async () => {
    const fake = new FakeYouCam({ runningPolls: 1 });
    const { blobs } = setup(fake);
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const photo = await addBuyerPhoto(prisma, blobs, buyer.id);

    // First "process": the poll throws (e.g. the server dies mid-poll).
    const crashing = new TryOnService({
      prisma,
      blobs,
      ledger: new Ledger(prisma, { youcamDailyUnits: 60, buyerDailyRenders: 6, geminiDailyLimit: 18 }),
      youcam: (l) => {
        const c = fake.client(l);
        c.clothesV3.poll = async () => {
          throw new Error("process killed");
        };
        return c;
      },
    });
    const r = await crashing.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id });
    await crashing.idle();
    const mid = await prisma.tryOn.findUniqueOrThrow({ where: { id: (r as { tryOn: { id: string } }).tryOn.id } });
    expect(mid).toMatchObject({ status: "running" });
    expect(mid.taskId).toBe(fake.starts[0].taskId);

    // Second "process": resume on start finishes it without a new task.
    const { svc } = setup(fake);
    expect(await svc.resumeAll()).toEqual({ resumed: 1, abandoned: 0 });
    await svc.idle();
    expect(await prisma.tryOn.findUniqueOrThrow({ where: { id: mid.id } })).toMatchObject({ status: "succeeded", units: 2 });
    expect(fake.starts).toHaveLength(1);
  });

  it("abandons stale queued renders that never started", async () => {
    const { blobs, svc } = setup();
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const photo = await addBuyerPhoto(prisma, blobs, buyer.id);
    await prisma.tryOn.create({
      data: { inputsHash: "stale", garmentId: garment.id, buyerPhotoId: photo.id, category: "full_body", status: "queued", createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    expect(await svc.resumeAll()).toEqual({ resumed: 0, abandoned: 1 });
    expect(await prisma.tryOn.findUniqueOrThrow({ where: { inputsHash: "stale" } })).toMatchObject({ status: "failed", units: 0 });
  });

  it("blocks a render that returned the original clothes and records the wasted units", async () => {
    const { blobs, svc } = setup(new FakeYouCam({ render: "unchanged" }));
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const photo = await addBuyerPhoto(prisma, blobs, buyer.id);
    await svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id });
    await svc.idle();
    expect(await prisma.tryOn.findFirstOrThrow()).toMatchObject({ status: "succeeded", verdict: "block", units: 2, unitsWasted: 2 });
  });

  it("refuses when the daily unit cap would be crossed", async () => {
    const { blobs, svc, fake } = setup(new FakeYouCam(), { youcamDailyUnits: 2, buyerDailyRenders: 6, geminiDailyLimit: 18 });
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const p1 = await addBuyerPhoto(prisma, blobs, buyer.id, "#2b6cb0");
    const p2 = await addBuyerPhoto(prisma, blobs, buyer.id, "#22aa55");
    expect((await svc.request({ garmentId: garment.id, buyerPhotoId: p1.id, buyerId: buyer.id })).kind).toBe("started");
    await svc.idle();
    expect(await svc.request({ garmentId: garment.id, buyerPhotoId: p2.id, buyerId: buyer.id })).toEqual({ kind: "refused", reason: "daily_cap" });
    expect(fake.starts).toHaveLength(1);
  });

  it("refuses a buyer's 7th new render of the day but still serves cached ones", async () => {
    const { blobs, svc } = setup(new FakeYouCam(), { youcamDailyUnits: 100, buyerDailyRenders: 1, geminiDailyLimit: 18 });
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const p1 = await addBuyerPhoto(prisma, blobs, buyer.id, "#2b6cb0");
    const p2 = await addBuyerPhoto(prisma, blobs, buyer.id, "#22aa55");
    await svc.request({ garmentId: garment.id, buyerPhotoId: p1.id, buyerId: buyer.id });
    await svc.idle();
    expect(await svc.request({ garmentId: garment.id, buyerPhotoId: p2.id, buyerId: buyer.id })).toEqual({ kind: "refused", reason: "buyer_cap" });
    expect((await svc.request({ garmentId: garment.id, buyerPhotoId: p1.id, buyerId: buyer.id })).kind).toBe("cached");
  });

  it("records a task error as failed with no units, and allows a retry", async () => {
    const fake = new FakeYouCam({ taskError: "error_no_face" });
    const { blobs, svc } = setup(fake);
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const photo = await addBuyerPhoto(prisma, blobs, buyer.id);
    await svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id });
    await svc.idle();
    expect(await prisma.tryOn.findFirstOrThrow()).toMatchObject({ status: "failed", units: 0, error: "error_no_face" });
    fake.opts.taskError = undefined;
    expect((await svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id })).kind).toBe("started");
    await svc.idle();
    expect(await prisma.tryOn.findFirstOrThrow()).toMatchObject({ status: "succeeded" });
  });

  it("marks a lost task as charged", async () => {
    const { blobs, svc } = setup(new FakeYouCam({ lose: true }));
    const { garment, buyer } = await seedBasics(prisma, blobs);
    const photo = await addBuyerPhoto(prisma, blobs, buyer.id);
    await svc.request({ garmentId: garment.id, buyerPhotoId: photo.id, buyerId: buyer.id });
    await svc.idle();
    expect(await prisma.tryOn.findFirstOrThrow()).toMatchObject({ status: "lost", units: 2, unitsWasted: 2 });
  });
});
