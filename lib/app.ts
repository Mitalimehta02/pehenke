import { ConsentService } from "./consent/service";
import { Engine } from "./engine/engine";
import type { PrismaClient } from "./generated/prisma/client";
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
  pollTimeoutMs?: number;
}

/** Composition root: wires the services. Pure (no env access) so tests build it with fakes. */
export function createApp(d: AppDeps) {
  const blobs = new PrismaBlobStore(d.prisma);
  const ledger = new Ledger(d.prisma, d.caps, d.now);
  const consent = new ConsentService({ prisma: d.prisma, blobs, youcam: d.youcam, youcamLogger: () => ledger.youcamLogger(), now: d.now });
  const engine = new Engine({ prisma: d.prisma, blobs, consent });
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
  const orders = new OrderService({ prisma: d.prisma, engine, now: d.now });
  return { prisma: d.prisma, blobs, ledger, consent, engine, tryOns, orders };
}

export type App = ReturnType<typeof createApp>;
