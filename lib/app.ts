import type { RenderAuditor } from "./audit/types";
import { ConsentService } from "./consent/service";
import { Engine } from "./engine/engine";
import { FamilyVoteService } from "./family/service";
import type { PrismaClient } from "./generated/prisma/client";
import { GarmentGate } from "./gate/garmentGate";
import { GarmentService } from "./garments/service";
import { DEFAULT_APP_URL } from "./links";
import { OrderService } from "./orders/service";
import { PrismaBlobStore } from "./storage/blobs";
import { TryOnService } from "./tryon/service";
import { Ledger, type Caps } from "./units/ledger";
import type { CallLogger, YouCamClient } from "./youcam";

export interface AppDeps {
  prisma: PrismaClient;
  /** builds a YouCam client that logs with the given logger (real in prod, FakeYouCam in tests) */
  youcam: (logger: CallLogger) => YouCamClient;
  caps: Caps;
  now?: () => Date;
  /** public base URL for shared links (APP_URL) */
  baseUrl?: string;
  pollTimeoutMs?: number;
  /** vision auditor for the seller photo gate (optional); receives a per-request hook for the Gemini budget */
  auditor?: (onRequest: (status: number | null) => void) => RenderAuditor | undefined;
}

/** Composition root: wires the services. Pure (no env access) so tests build it with fakes. */
export function createApp(d: AppDeps) {
  const blobs = new PrismaBlobStore(d.prisma);
  const ledger = new Ledger(d.prisma, d.caps, d.now);
  const consent = new ConsentService({ prisma: d.prisma, blobs, youcam: d.youcam, youcamLogger: () => ledger.youcamLogger(), now: d.now });
  const baseUrl = d.baseUrl ?? DEFAULT_APP_URL;
  const family = new FamilyVoteService({ prisma: d.prisma, now: d.now });
  const engine = new Engine({ prisma: d.prisma, blobs, consent, baseUrl, family });
  family.onVote = (e) => engine.onFamilyVote(e);
  const tryOns = new TryOnService({
    prisma: d.prisma,
    blobs,
    ledger,
    youcam: d.youcam,
    now: d.now,
    pollTimeoutMs: d.pollTimeoutMs,
    onFinished: (id) => engine.onTryOnFinished(id),
  });
  engine.tryOns = tryOns;
  const orders = new OrderService({ prisma: d.prisma, blobs, engine, now: d.now });
  const auditor = d.auditor?.((status) => ledger.logGemini("interactions", status));
  const gate = new GarmentGate({ auditor, ledger });
  const garments = new GarmentService({ prisma: d.prisma, blobs, gate, now: d.now });
  return { prisma: d.prisma, baseUrl, blobs, ledger, consent, engine, tryOns, orders, family, gate, garments, auditor };
}

export type App = ReturnType<typeof createApp>;
