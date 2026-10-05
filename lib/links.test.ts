import { describe, expect, it } from "vitest";
import { links, waLink } from "./links";

describe("links", () => {
  it("builds absolute links from the base URL (trailing slash tolerated)", () => {
    expect(links.chat("https://a.example/", "meera")).toBe("https://a.example/chat/meera");
    expect(links.chat("https://a.example", "meera", "g1")).toBe("https://a.example/chat/meera?g=g1");
    expect(links.seller("https://a.example", "meera", "k+/=")).toBe("https://a.example/seller/meera?key=k%2B%2F%3D");
    expect(links.card("https://a.example", "tok")).toBe("https://a.example/card/tok");
    expect(links.vote("", "tok")).toBe("/v/tok");
  });

  it("wa.me links: digits-only number, URL-encoded text", () => {
    const text = "Order #AB12 ✅\nSee: https://a.example/card/x?y=1&z=2";
    const l = waLink(text, "+91 98765 43210");
    expect(l.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(decodeURIComponent(l.split("text=")[1])).toBe(text);
    expect(waLink("hi")).toBe("https://wa.me/?text=hi");
    expect(waLink("hi", null)).toBe("https://wa.me/?text=hi");
  });
});
