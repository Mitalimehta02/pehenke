import { describe, expect, it } from "vitest";
import { setupTestDb } from "../testing/db";
import { hashKey, secretsMatch } from "./keys";
import { createSeller, OnboardError, rotateSellerKey, slugify } from "./onboard";

const db = setupTestDb();
const BASE = "https://shop.example";
const keyOf = (sellerUrl: string) => new URL(sellerUrl).searchParams.get("key")!;

describe("slugify", () => {
  it.each([
    ["Meera's Boutique", "meeras-boutique"],
    ["  Kala  Niketan, Jaipur ", "kala-niketan-jaipur"],
    ["Café Ré", "cafe-re"],
    ["मीरा बुटीक", ""],
  ])("%j -> %j", (name, slug) => expect(slugify(name)).toBe(slug));
});

describe("createSeller", () => {
  it("creates a real (non-demo) seller and returns its private and public links; only the key's hash is stored", async () => {
    const s = await createSeller(db.prisma, BASE, { name: "Meera's Boutique" });
    expect(s.slug).toBe("meeras-boutique");
    expect(s.chatUrl).toBe("https://shop.example/chat/meeras-boutique");
    expect(s.sellerUrl).toMatch(/^https:\/\/shop\.example\/seller\/meeras-boutique\?key=[A-Za-z0-9_-]{24}$/);
    const row = await db.prisma.seller.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.isDemo).toBe(false);
    expect(row.accessKeyHash).toBe(hashKey(keyOf(s.sellerUrl)));
    expect(JSON.stringify(row)).not.toContain(keyOf(s.sellerUrl));
  });

  it("picks a free link name, or rejects a taken / invalid one", async () => {
    await createSeller(db.prisma, BASE, { name: "Asha Sarees" });
    expect((await createSeller(db.prisma, BASE, { name: "Asha Sarees" })).slug).toBe("asha-sarees-2");
    expect((await createSeller(db.prisma, BASE, { name: "मीरा" })).slug).toMatch(/^shop-[0-9a-f]{6}$/);
    expect((await createSeller(db.prisma, BASE, { name: "Rani", slug: "rani-jaipur" })).slug).toBe("rani-jaipur");
    await expect(createSeller(db.prisma, BASE, { name: "X", slug: "ok" })).rejects.toBeInstanceOf(OnboardError);
    await expect(createSeller(db.prisma, BASE, { name: "Rani 2", slug: "rani-jaipur" })).rejects.toThrow(/taken/);
    await expect(createSeller(db.prisma, BASE, { name: "Bad", slug: "Bad Slug!" })).rejects.toThrow(/Link name/);
  });

  it("a new seller link replaces the old one", async () => {
    const s = await createSeller(db.prisma, BASE, { name: "Rani Fashion" });
    const r = await rotateSellerKey(db.prisma, BASE, s.id);
    const row = await db.prisma.seller.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.accessKeyHash).toBe(hashKey(keyOf(r.sellerUrl)));
    expect(row.accessKeyHash).not.toBe(hashKey(keyOf(s.sellerUrl)));
    const demo = await db.prisma.seller.create({ data: { slug: "demo", name: "Demo", accessKeyHash: "x", isDemo: true } });
    await expect(rotateSellerKey(db.prisma, BASE, demo.id)).rejects.toThrow(/demo/);
  });
});

describe("secretsMatch", () => {
  it("compares in constant time, any lengths", () => {
    expect(secretsMatch("a-long-admin-secret", "a-long-admin-secret")).toBe(true);
    expect(secretsMatch("a-long-admin-secret", "a-long-admin-secreT")).toBe(false);
    expect(secretsMatch("short", "a-long-admin-secret")).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch(null, "x")).toBe(false);
  });
});
