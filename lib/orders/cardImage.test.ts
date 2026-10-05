import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { garmentImage, personImage } from "../testing/fixtures";
import { buildOrderCard } from "./cardData";
import { CARD_W, renderCardImage } from "./cardImage";

const order = (disclosure: string | null, label = "Ivory silk saree") =>
  buildOrderCard({ id: "cmabc123hnxzf6", disclosureText: disclosure, garment: { label, priceInr: 2499 }, seller: { name: "Meera Boutique" }, tryOn: { outputKey: "tryon/x.jpg" } });

describe("renderCardImage", () => {
  it("renders one JPEG, 1080 wide, taller with longer text", async () => {
    const tryOn = await personImage();
    const garment = await garmentImage();
    const short = await renderCardImage({ card: order(null), tryOn, garment });
    const long = await renderCardImage({
      card: order("Saree as ordered. Styling, accessories and other garments shown are illustrative.", "Ivory Kanjivaram silk saree with a wide gold zari border and an unstitched blouse piece"),
      tryOn,
      garment,
    });
    const meta = await sharp(short.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(CARD_W);
    expect(meta.height).toBe(short.height);
    expect(long.height).toBeGreaterThan(short.height);
    expect(long.height).toBeLessThan(2000);
  });

  it("still renders without a try-on image (photo deleted)", async () => {
    const r = await renderCardImage({ card: order(null), tryOn: null, garment: null });
    expect(r.width).toBe(CARD_W);
    expect(r.height).toBeLessThan(1000);
  });

  it("escapes markup in seller-provided text", async () => {
    const r = await renderCardImage({ card: order(null, "Kurti <b>& dupatta</b>"), tryOn: null, garment: null });
    expect(r.bytes.length).toBeGreaterThan(1000);
  });
});
