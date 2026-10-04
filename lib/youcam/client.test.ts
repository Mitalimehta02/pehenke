import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { YouCamClient } from "./client";
import { TaskLostError, TaskPollTimeoutError, YouCamApiError } from "./errors";
import type { CallLogEntry } from "./http";
import { unitsPerImage } from "./credit";

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(handler: Handler) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const logs: CallLogEntry[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  const client = new YouCamClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl,
    logger: (e) => logs.push(e),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, logs, sleeps };
}

const COSTS = {
  status: 200,
  result: {
    next_token: null,
    skus: [
      { description: "AI Clothes V3", amount: 20, unit: "result_image", proc_unit: 1, run_task_url: "https://api.example.test/s2s/v2.0/task/cloth-v3" },
      { description: "Skin tone", amount: 3, unit: "result_image", proc_unit: 1, run_task_url: "https://api.example.test/s2s/v2.0/task/skin-tone-analysis" },
    ],
  },
};

describe("http", () => {
  it("sends the bearer key and never puts it in logs", async () => {
    const { client, calls, logs } = setup(() => json(200, COSTS));
    await client.featureCosts();
    const auth = new Headers(calls[0].init?.headers).get("authorization");
    expect(auth).toBe("Bearer test-key");
    expect(JSON.stringify(logs)).not.toContain("test-key");
  });

  it("does not retry a task start on 5xx (could pay twice)", async () => {
    const { client, calls } = setup(() => json(500, { status: 500, error_code: "Boom" }));
    await expect(client.clothesV3.start({ src_file_id: "a", ref_file_id: "b", garment_category: "upper_body" })).rejects.toBeInstanceOf(YouCamApiError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a task start on network error", async () => {
    const { client, calls } = setup(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client.clothesV3.start({ src_file_id: "a", ref_file_id: "b", garment_category: "upper_body" })).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(1);
  });

  it("retries a task start on 429", async () => {
    let n = 0;
    const { client, calls } = setup(() => (++n === 1 ? json(429, {}) : json(200, { status: 200, data: { task_id: "t1" } })));
    await expect(client.clothesV3.start({ src_file_id: "a", ref_file_id: "b", garment_category: "upper_body" })).resolves.toBe("t1");
    expect(calls).toHaveLength(2);
  });

  it("retries status checks on 5xx", async () => {
    let n = 0;
    const { client, calls } = setup((url) => {
      if (url.pathname.includes("feature-cost")) return json(200, COSTS);
      return ++n === 1 ? json(502, {}) : json(200, { status: 200, data: { task_status: "running" } });
    });
    await expect(client.getTask("cloth-v3", "t1")).resolves.toMatchObject({ task_status: "running" });
    expect(calls.filter((c) => c.url.pathname.includes("/task/"))).toHaveLength(2);
  });
});

describe("pollTask", () => {
  it("backs off until success and logs units once, on the success call", async () => {
    let n = 0;
    const { client, logs, sleeps } = setup((url) => {
      if (url.pathname.includes("feature-cost")) return json(200, COSTS);
      n++;
      return n < 4
        ? json(200, { status: 200, data: { task_status: "running" } })
        : json(200, { status: 200, data: { task_status: "success", results: { url: "https://cdn.example.test/out.jpg" } } });
    });
    await client.featureCosts();
    const status = await client.clothesV3.poll("t1", { initialDelayMs: 1000, factor: 2, maxDelayMs: 3000 });
    expect(status.results?.url).toBe("https://cdn.example.test/out.jpg");
    expect(sleeps).toEqual([1000, 2000, 3000, 3000]);
    const polls = logs.filter((l) => l.note === "poll");
    expect(polls.map((l) => l.units)).toEqual([0, 0, 0, 20]);
  });

  it("returns error status without charging", async () => {
    const { client, logs } = setup((url) =>
      url.pathname.includes("feature-cost") ? json(200, COSTS) : json(200, { status: 200, data: { task_status: "error", error: "error_no_face" } }),
    );
    await client.featureCosts();
    const s = await client.clothesV3.poll("t1");
    expect(s.error).toBe("error_no_face");
    expect(logs.at(-1)?.units).toBe(0);
  });

  it("logs units as unknown (null) when costs were not loaded", async () => {
    const { client, logs } = setup(() => json(200, { status: 200, data: { task_status: "success", results: { url: "u" } } }));
    await client.clothesV3.poll("t1");
    expect(logs.at(-1)?.units).toBeNull();
  });

  it("throws TaskPollTimeoutError carrying the task id", async () => {
    const { client } = setup(() => json(200, { status: 200, data: { task_status: "running" } }));
    // fake sleep doesn't advance time, so make the deadline already passed
    await expect(client.clothesV3.poll("t-slow", { timeoutMs: 0 })).rejects.toMatchObject({ name: "TaskPollTimeoutError", taskId: "t-slow" });
    await expect(client.clothesV3.poll("t-slow", { timeoutMs: 0 })).rejects.toBeInstanceOf(TaskPollTimeoutError);
  });

  it("maps InvalidTaskId to TaskLostError", async () => {
    const { client } = setup(() => json(400, { status: 400, error_code: "InvalidTaskId" }));
    await expect(client.clothesV3.poll("gone")).rejects.toBeInstanceOf(TaskLostError);
  });

  it("run() reports the task id before polling", async () => {
    const order: string[] = [];
    const { client } = setup((url, init) => {
      if (init?.method === "POST") return json(200, { status: 200, data: { task_id: "t9" } });
      order.push("poll");
      return json(200, { status: 200, data: { task_status: "success", results: { url: "u" } } });
    });
    await client.clothesV3.run(
      { src_file_id: "a", ref_file_id: "b", garment_category: "full_body" },
      { onTaskStarted: (id) => void order.push(`started:${id}`) },
    );
    expect(order).toEqual(["started:t9", "poll"]);
  });
});

describe("upload", () => {
  it("registers the file then PUTs bytes to the pre-signed URL", async () => {
    const { client, calls, logs } = setup((url) => {
      if (url.host === "api.example.test") {
        return json(200, {
          status: 200,
          data: {
            files: [
              {
                content_type: "image/jpg",
                file_name: "p.jpg",
                file_id: "fid-1",
                requests: [{ method: "PUT", url: "https://bucket.example.test/up?sig=SECRET", headers: { "Content-Type": "image/jpg", "Content-Length": 3 } }],
              },
            ],
          },
        });
      }
      return new Response(null, { status: 200 });
    });
    const id = await client.clothesV3.upload({ bytes: new Uint8Array([1, 2, 3]), fileName: "p.jpg", contentType: "image/jpg" });
    expect(id).toBe("fid-1");
    const reg = JSON.parse(String(calls[0].init?.body));
    expect(reg).toEqual({ files: [{ content_type: "image/jpg", file_name: "p.jpg", file_size: 3 }] });
    expect(calls[0].url.pathname).toBe("/s2s/v2.0/file/cloth-v3");
    expect(calls[1].init?.method).toBe("PUT");
    expect(new Headers(calls[1].init?.headers).get("content-type")).toBe("image/jpg");
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });
});

describe("balance auth fallback", () => {
  it("uses the API key when the balance endpoint accepts it", async () => {
    const { client, calls } = setup(() => json(200, { status: 200, results: [{ id: 1, type: "ApiPaygToken", amount: 1000, expiry: 0 }] }));
    await expect(client.balance()).resolves.toMatchObject({ total: 1000, auth: "api-key" });
    expect(calls).toHaveLength(1);
  });

  it("falls back to a V1 token from the secret key on 401", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const secret = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    let idToken = "";
    const calls: Array<{ path: string; auth: string | null }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ path: url.pathname, auth });
      if (url.pathname === "/s2s/v1.0/client/auth") {
        const body = JSON.parse(String(init?.body));
        expect(body.client_id).toBe("api-key-1");
        idToken = body.id_token;
        return json(200, { status: 200, result: { access_token: "tok-1" } });
      }
      return auth === "Bearer tok-1"
        ? json(200, { status: 200, results: [{ id: 1, type: "ApiPaygToken", amount: 990, expiry: 0 }] })
        : json(401, { status: 401, error_code: "InvalidAccessToken" });
    }) as typeof fetch;
    const client = new YouCamClient({ apiKey: "api-key-1", secretKey: secret, baseUrl: "https://api.example.test", fetchImpl, logger: () => {} });

    await expect(client.balance()).resolves.toMatchObject({ total: 990, auth: "v1-token" });
    expect(calls.map((c) => c.path)).toEqual(["/s2s/v1.0/client/credit", "/s2s/v1.0/client/auth", "/s2s/v1.0/client/credit"]);
    expect(calls[1].auth).toBeNull();
    // id_token is "client_id=<key>&timestamp=<ms>" encrypted to the secret key
    const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(idToken, "base64")).toString();
    expect(plain).toMatch(/^client_id=api-key-1&timestamp=\d{13}$/);

    // later calls reuse the token without retrying the API key
    await client.balance();
    expect(calls.slice(3).map((c) => c.path)).toEqual(["/s2s/v1.0/client/credit"]);
  });

  it("rethrows the 401 when no secret key is configured", async () => {
    const { client } = setup(() => json(401, { status: 401, error_code: "InvalidAccessToken" }));
    await expect(client.balance()).rejects.toBeInstanceOf(YouCamApiError);
  });
});

describe("unitsPerImage", () => {
  it("matches the feature's task endpoint exactly", () => {
    const skus = [
      ...COSTS.result.skus,
      { description: "Clothes v2", amount: 10, unit: "result_image" as const, proc_unit: 1, run_task_url: "https://x/s2s/v2.0/task/cloth" },
    ] as never;
    expect(unitsPerImage(skus, "cloth-v3")).toBe(20);
    expect(unitsPerImage(skus, "skin-tone-analysis")).toBe(3);
  });

  it("is null when prices are ambiguous", () => {
    const skus = [
      { description: "a", amount: 5, unit: "result_image", proc_unit: 1, run_task_url: "https://x/s2s/v2.0/task/cloth-v3" },
      { description: "b", amount: 9, unit: "result_image", proc_unit: 1, run_task_url: "https://x/s2s/v2.0/task/cloth-v3" },
    ] as never;
    expect(unitsPerImage(skus, "cloth-v3")).toBeNull();
  });
});
