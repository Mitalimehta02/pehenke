import type { CallLogEntry } from "../youcam/http";
import type { PrismaClient } from "../generated/prisma/client";
import { istDay, startOfIstDay } from "../time";

/** YouCam cost of one cloth-v3 render (verified live: 2 units, charged only on success). */
export const RENDER_UNITS = 2;

export interface Caps {
  youcamDailyUnits: number;
  buyerDailyRenders: number;
  geminiDailyLimit: number;
}

export type RenderRefusal = "daily_cap" | "buyer_cap";

/**
 * Units ledger: every YouCam and Gemini call is written to ApiCall. Daily caps
 * are checked against it (IST day), counting units already spent plus units
 * reserved for renders still running.
 */
export class Ledger {
  private pending: Promise<unknown>[] = [];
  private taskChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaClient,
    readonly caps: Caps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Logger for YouCamClient. Writes are queued; call flush() before reading totals. */
  youcamLogger(context: { tryOnId?: string } = {}) {
    return (e: CallLogEntry) => {
      const raw = /\/task\/[^/]+\/([^/?]+)/.exec(e.path)?.[1];
      const taskId = raw ? decodeURIComponent(raw) : null;
      // null = charged but size unknown: count the full render cost to stay safe
      const units = e.units ?? RENDER_UNITS;
      // Chain per task so "already charged?" sees the previous write for the same task.
      const prev = taskId ? (this.taskChains.get(taskId) ?? Promise.resolve()) : Promise.resolve();
      const write = prev.then(async () => {
        // YouCam charges a task once. A later poll that sees "success" again (e.g. after a
        // resume) must not be logged as a second charge (seen live: ledger 22 vs YouCam 20).
        const already = units > 0 && taskId ? await this.prisma.apiCall.findFirst({ where: { provider: "youcam", taskId, units: { gt: 0 } } }) : null;
        await this.prisma.apiCall.create({
          data: {
            provider: "youcam",
            endpoint: `${e.method} ${e.path.replace(/\/task\/([^/]+)\/[^/?]+/, "/task/$1/:id")}`,
            httpStatus: typeof e.httpStatus === "number" ? e.httpStatus : null,
            units: already ? 0 : units,
            taskId,
            tryOnId: context.tryOnId ?? null,
            day: istDay(new Date(e.at)),
          },
        });
      });
      if (taskId) this.taskChains.set(taskId, write.catch(() => undefined));
      this.track(write);
    };
  }

  logGemini(endpoint: string, httpStatus: number | null) {
    this.track(this.prisma.apiCall.create({ data: { provider: "gemini", endpoint, httpStatus, units: 0, day: istDay(this.now()) } }));
  }

  private track(p: Promise<unknown>) {
    const q = p.catch((err) => console.error("[ledger] write failed", err));
    this.pending.push(q);
    void q.finally(() => (this.pending = this.pending.filter((x) => x !== q)));
  }

  async flush() {
    await Promise.all(this.pending);
  }

  async youcamUnitsToday(): Promise<number> {
    await this.flush();
    const r = await this.prisma.apiCall.aggregate({ _sum: { units: true }, where: { provider: "youcam", day: istDay(this.now()) } });
    return r._sum.units ?? 0;
  }

  async geminiCallsToday(): Promise<number> {
    await this.flush();
    return this.prisma.apiCall.count({ where: { provider: "gemini", day: istDay(this.now()) } });
  }

  async geminiAvailable(): Promise<boolean> {
    return (await this.geminiCallsToday()) < this.caps.geminiDailyLimit;
  }

  /** Whether a new (uncached) render may start now, for this buyer (null for pre-renders). */
  async canStartRender(buyerId: string | null): Promise<{ ok: true } | { ok: false; reason: RenderRefusal }> {
    const spent = await this.youcamUnitsToday();
    const running = await this.prisma.tryOn.count({ where: { status: { in: ["queued", "running"] } } });
    if (spent + (running + 1) * RENDER_UNITS > this.caps.youcamDailyUnits) return { ok: false, reason: "daily_cap" };
    if (buyerId) {
      const mine = await this.prisma.tryOn.count({
        where: { requestedById: buyerId, createdAt: { gte: startOfIstDay(this.now()) }, status: { in: ["queued", "running", "succeeded"] } },
      });
      if (mine >= this.caps.buyerDailyRenders) return { ok: false, reason: "buyer_cap" };
    }
    return { ok: true };
  }
}
