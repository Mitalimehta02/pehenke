import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { GeminiAuditor } from "./gemini";
import type { RenderAudit, RenderAuditInput } from "./types";

const AUDIT: RenderAudit = {
  garment_match: { verdict: "match", notes: "" },
  length: { reference: "floor", output: "floor", matches: true },
  added_items: [{ item: "pearl necklace", kind: "jewellery", location: "neck" }],
  person_changes: { face_changed: false, hair_changed: false, background_changed: false, notes: "" },
  drape: "natural",
  reference_leak: { reference_has_figure: false, leaked: [] },
  summary: "Invented necklace.",
};

async function input(): Promise<RenderAuditInput> {
  const img = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#a33" } }).jpeg().toBuffer();
  const i = { bytes: img, mimeType: "image/jpeg" as const };
  return { person: i, garment: i, output: i, garmentLabel: "saree", category: "full_body" };
}

describe("GeminiAuditor", () => {
  it("sends three shrunk images with store=false and a JSON schema, and parses the result", async () => {
    let sent: Record<string, unknown> | undefined;
    const a = new GeminiAuditor({
      apiKey: "k",
      sleep: async () => {},
      create: async (p) => {
        sent = p as Record<string, unknown>;
        return { output_text: JSON.stringify(AUDIT) };
      },
    });
    await expect(a.auditRender(await input())).resolves.toEqual(AUDIT);
    expect(sent?.store).toBe(false);
    expect(sent?.model).toBe("gemini-3.8-flash");
    const parts = sent?.input as Array<{ type: string; data?: string }>;
    const images = parts.filter((p) => p.type === "image");
    expect(images).toHaveLength(3);
    const meta = await sharp(Buffer.from(images[0].data!, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1024);
    expect((sent?.response_format as { schema: object }).schema).toHaveProperty("properties.added_items");
  });

  it("backs off on 429 and succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const a = new GeminiAuditor({
      apiKey: "k",
      minGapMs: 0,
      sleep: async (ms) => void sleeps.push(ms),
      create: async () => {
        if (++n < 3) throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 });
        return { output_text: JSON.stringify(AUDIT) };
      },
    });
    await expect(a.auditRender(await input())).resolves.toEqual(AUDIT);
    expect(sleeps).toEqual([5000, 10000]);
  });

  it("does not retry other errors", async () => {
    let n = 0;
    const a = new GeminiAuditor({
      apiKey: "k",
      sleep: async () => {},
      create: async () => {
        n++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
    });
    await expect(a.auditRender(await input())).rejects.toThrow("bad request");
    expect(n).toBe(1);
  });

  it("runs one audit at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const a = new GeminiAuditor({
      apiKey: "k",
      minGapMs: 0,
      sleep: async () => {},
      create: async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { output_text: JSON.stringify(AUDIT) };
      },
    });
    const inp = await input();
    await Promise.all([a.auditRender(inp), a.auditRender(inp), a.auditRender(inp)]);
    expect(maxActive).toBe(1);
  });

  it("rejects output that doesn't match the schema", async () => {
    const a = new GeminiAuditor({ apiKey: "k", sleep: async () => {}, create: async () => ({ output_text: '{"summary":"x"}' }) });
    await expect(a.auditRender(await input())).rejects.toThrow();
  });
});
