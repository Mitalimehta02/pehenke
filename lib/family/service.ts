import type { PrismaClient } from "../generated/prisma/client";
import { hashKey, newToken } from "../sellers/keys";
import { DAY_MS } from "../time";

/**
 * "Ask family": the buyer chooses to share one try-on image through a public,
 * expiring link (/v/<token>). Visitors see only that image and the outfit
 * name, vote yes/no with an optional name, no login. One (changeable) vote per
 * browser. The tally goes back to the buyer's chat. Links expire after
 * VOTE_DAYS and are deleted with the buyer's photos.
 */

export const VOTE_DAYS = 7;
/** responses accepted per link (stops a script from flooding the buyer's chat) */
export const MAX_RESPONSES = 100;
export const MAX_NAME = 40;

export class VoteClosedError extends Error {}

export interface Tally {
  yes: number;
  no: number;
}

export interface VoteEvent {
  voteId: string;
  conversationId: string;
  garmentLabel: string;
  tally: Tally;
  latest: { likes: boolean; name: string | null };
}

export function cleanName(name: string | null | undefined): string | null {
  const n = (name ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return n || null;
}

export class FamilyVoteService {
  /** called after every vote (the engine posts the tally to the buyer's chat) */
  onVote?: (e: VoteEvent) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly d: { prisma: PrismaClient; now?: () => Date }) {
    this.now = d.now ?? (() => new Date());
  }

  /** The buyer's open link for this try-on, or a new one. */
  async create(p: { tryOnId: string; buyerId: string; conversationId: string; garmentLabel: string }) {
    const { prisma } = this.d;
    const existing = await prisma.familyVote.findFirst({
      where: { tryOnId: p.tryOnId, buyerId: p.buyerId, conversationId: p.conversationId, expiresAt: { gt: this.now() } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { vote: existing, reused: true };
    const vote = await prisma.familyVote.create({
      data: { ...p, token: newToken(), expiresAt: new Date(this.now().getTime() + VOTE_DAYS * DAY_MS) },
    });
    return { vote, reused: false };
  }

  /** An open (not expired, not deleted) link with its image key, or null. */
  async findOpen(token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const vote = await this.d.prisma.familyVote.findUnique({ where: { token }, include: { tryOn: { select: { outputKey: true } } } });
    if (!vote || vote.expiresAt <= this.now() || !vote.tryOn.outputKey) return null;
    return vote;
  }

  /** The visitor's current vote on this link, if any. */
  async myVote(voteId: string, voterId: string | null) {
    if (!voterId) return null;
    return this.d.prisma.familyVoteResponse.findUnique({ where: { voteId_voterKey: { voteId, voterKey: voterKey(voteId, voterId) } } });
  }

  async cast(token: string, voterId: string, likes: boolean, name?: string | null): Promise<Tally> {
    const { prisma } = this.d;
    const vote = await this.findOpen(token);
    if (!vote) throw new VoteClosedError("this link has expired");
    const key = voterKey(vote.id, voterId);
    const mine = await prisma.familyVoteResponse.findUnique({ where: { voteId_voterKey: { voteId: vote.id, voterKey: key } } });
    if (!mine && (await prisma.familyVoteResponse.count({ where: { voteId: vote.id } })) >= MAX_RESPONSES) {
      throw new VoteClosedError("this link has reached its vote limit");
    }
    const clean = cleanName(name);
    await prisma.familyVoteResponse.upsert({
      where: { voteId_voterKey: { voteId: vote.id, voterKey: key } },
      create: { voteId: vote.id, voterKey: key, likes, name: clean },
      update: { likes, name: clean ?? mine?.name ?? null },
    });
    const tally = await this.tally(vote.id);
    // a changed vote with the same answer isn't news for the buyer
    if (!mine || mine.likes !== likes) {
      await this.onVote?.({ voteId: vote.id, conversationId: vote.conversationId, garmentLabel: vote.garmentLabel, tally, latest: { likes, name: clean ?? mine?.name ?? null } });
    }
    return tally;
  }

  async tally(voteId: string): Promise<Tally> {
    const rows = await this.d.prisma.familyVoteResponse.groupBy({ by: ["likes"], where: { voteId }, _count: { _all: true } });
    return { yes: rows.find((r) => r.likes)?._count._all ?? 0, no: rows.find((r) => !r.likes)?._count._all ?? 0 };
  }

  /** Delete expired links (and their votes). */
  async purgeExpired(): Promise<number> {
    return (await this.d.prisma.familyVote.deleteMany({ where: { expiresAt: { lte: this.now() } } })).count;
  }
}

/** Per-link hash of the browser id: votes can't be linked across links or back to the cookie. */
const voterKey = (voteId: string, voterId: string) => hashKey(`${voteId}:${voterId}`);
