import type { Http } from "./http";
import type { Feature, FeatureCostResponse, FeatureCostSku, UnitBalanceEntry, UnitBalanceResponse } from "./types";

/** All SKUs from the feature-cost endpoint (paged, max 20 per page). */
export async function getFeatureCosts(http: Http): Promise<FeatureCostSku[]> {
  const skus: FeatureCostSku[] = [];
  let token: string | null = null;
  for (let page = 0; page < 50; page++) {
    const res: FeatureCostResponse = await http.request<FeatureCostResponse>("GET", "/s2s/v2.0/credit/feature-cost", {
      query: { page_size: 20, starting_token: token },
      retry: "safe",
    });
    skus.push(...res.result.skus);
    token = res.result.next_token;
    if (!token) return skus;
  }
  throw new Error("feature-cost pagination did not terminate");
}

/** SKUs whose run_task_url is this feature's task endpoint. */
export function skusForFeature(skus: FeatureCostSku[], feature: Feature): FeatureCostSku[] {
  return skus.filter((s) => {
    try {
      return new URL(s.run_task_url).pathname.replace(/\/+$/, "").endsWith(`/task/${feature}`);
    } catch {
      return false;
    }
  });
}

/**
 * Units per successful image task, or null when the table is ambiguous
 * (no SKU, several SKUs with different prices, or a per-second SKU).
 */
export function unitsPerImage(skus: FeatureCostSku[], feature: Feature): number | null {
  const matches = skusForFeature(skus, feature).filter((s) => s.unit === "result_image");
  const prices = new Set(matches.map((s) => s.amount / (s.proc_unit || 1)));
  return prices.size === 1 ? [...prices][0] : null;
}

/**
 * Current unit balance. Documented under V1 auth (access token); whether the
 * V2 API key is accepted here is unverified, so callers must handle failure.
 */
export async function getBalance(http: Http): Promise<{ total: number; entries: UnitBalanceEntry[] }> {
  const res = await http.request<UnitBalanceResponse>("GET", "/s2s/v1.0/client/credit", { retry: "safe" });
  const entries = res.results ?? [];
  return { total: entries.reduce((n, e) => n + e.amount, 0), entries };
}
