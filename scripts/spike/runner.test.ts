import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { YouCamClient } from "@/lib/youcam";

// Point the spike at a throwaway workspace before its modules load.
const dir = mkdtempSync(path.join(tmpdir(), "spike-test-"));
process.env.SPIKE_OUT_DIR = path.join(dir, "out");
process.env.SPIKE_ASSETS_DIR = path.join(dir, "assets");
process.env.SPIKE_UNIT_CAP = "50";

const store = await import("./store");
const runner = await import("./runner");
const assets = await import("./assets");

const API = "https://api.example.test";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let pollMode: "network-down" | "success" = "network-down";
let starts = 0;
let outputJpeg: Buffer;

const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host === "bucket.example.test") return new Response(null, { status: 200 });
  if (url.host === "cdn.example.test") return new Response(new Uint8Array(outputJpeg), { status: 200, headers: { "content-type": "image/jpeg" } });
  if (url.pathname === "/s2s/v2.0/credit/feature-cost") {
    return json(200, { status: 200, result: { next_token: null, skus: [{ description: "c", amount: 20, unit: "result_image", proc_unit: 1, run_task_url: `${API}/s2s/v2.0/task/cloth-v3` }] } });
  }
  if (url.pathname === "/s2s/v1.0/client/credit") return json(401, { status: 401, error_code: "InvalidAccessToken" });
  if (url.pathname.startsWith("/s2s/v2.0/file/")) {
    return json(200, { status: 200, data: { files: [{ file_id: `fid-${Math.random()}`, requests: [{ method: "PUT", url: "https://bucket.example.test/x", headers: {} }] }] } });
  }
  if (url.pathname === "/s2s/v2.0/task/cloth-v3" && init?.method === "POST") {
    starts++;
    return json(200, { status: 200, data: { task_id: "task-1" } });
  }
  if (url.pathname === "/s2s/v2.0/task/cloth-v3/task-1") {
    if (pollMode === "network-down") throw new TypeError("fetch failed");
    return json(200, { status: 200, data: { task_status: "success", results: { url: "https://cdn.example.test/out.jpg" } } });
  }
  throw new Error(`unexpected ${init?.method} ${url}`);
}) as typeof fetch;

const client = new YouCamClient({ apiKey: "k", baseUrl: API, fetchImpl, logger: () => {}, sleep: async () => {} });

async function photo(torso: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="100%" height="100%" fill="#ccc"/><rect x="160" y="190" width="280" height="330" fill="${torso}"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

beforeAll(async () => {
  mkdirSync(store.GARMENTS_DIR, { recursive: true });
  mkdirSync(store.PEOPLE_DIR, { recursive: true });
  writeFileSync(path.join(store.GARMENTS_DIR, "kurti.jpg"), await photo("#1e90ff"));
  writeFileSync(path.join(store.GARMENTS_DIR, "salwar.jpg"), await photo("#333"));
  writeFileSync(path.join(store.PEOPLE_DIR, "asha-full.jpg"), await photo("#b22222"));
  writeFileSync(store.GARMENTS_CSV, "file,label,category,photo_type\nkurti.jpg,kurti,upper_body,hanger\nsalwar.jpg,salwar,lower_body,flatlay\n");
  outputJpeg = await photo("#1e90ff");
  await client.featureCosts();
});

describe("spike runner", () => {
  it("skips lower-body product shots and parses framing", () => {
    const plan = assets.planTryOns(assets.loadGarments(), assets.loadPeople(), {});
    expect(plan.jobs.map((j) => [j.garmentFile, j.person, j.framing])).toEqual([["kurti.jpg", "asha", "full"]]);
    expect(plan.skipped[0].what).toBe("salwar.jpg");
  });

  it("plans repeat renders under new keys and keeps the original key", () => {
    const base = assets.planTryOns(assets.loadGarments(), assets.loadPeople(), {}).jobs;
    const rep = assets.planTryOns(assets.loadGarments(), assets.loadPeople(), { repeat: 2 }).jobs;
    expect(rep).toHaveLength(base.length * 3);
    expect(rep[0].key).toBe(base[0].key);
    expect(new Set(rep.map((j) => j.key)).size).toBe(rep.length);
    expect(rep.map((j) => j.repeat ?? 0)).toEqual([0, 1, 2]);
  });

  it("keeps the task id on disk when polling dies, then resumes it without starting a new task", async () => {
    const [job] = assets.planTryOns(assets.loadGarments(), assets.loadPeople(), {}).jobs;

    // Run 1: the task starts, then the network dies during polling.
    await expect(runner.executeJob(client, job)).rejects.toThrow("fetch failed");
    expect(store.loadPending().map((p) => p.taskId)).toEqual(["task-1"]);
    expect(store.loadCache()[job.key]).toBeUndefined();
    // budget holds the pending task's cost in reserve
    expect((await runner.budget(client)).reserved).toBe(20);

    // Run 2: resume finishes it, downloads the image immediately, and records units.
    pollMode = "success";
    expect(await runner.resumePending(client)).toEqual([]);
    expect(starts).toBe(1);
    expect(store.loadPending()).toEqual([]);
    const rec = store.loadCache()[job.key];
    expect(rec).toMatchObject({ status: "success", units: 20, resumed: true, taskId: "task-1" });
    expect(rec.outputPath && existsSync(path.resolve(rec.outputPath))).toBe(true);
    expect([rec.outputWidth, rec.outputHeight]).toEqual([600, 1000]);
    expect(rec.badRender?.flagged).toBe(false);
  });

  it("refuses a call that would cross the cap", async () => {
    // cap 50, 20 spent; a second distinct job costs 20 -> ok; third would hit 60
    writeFileSync(path.join(store.PEOPLE_DIR, "asha-chest.jpg"), await photo("#00aa00"));
    writeFileSync(path.join(store.PEOPLE_DIR, "ravi-full.jpg"), await photo("#aa00aa"));
    const jobs = assets.planTryOns(assets.loadGarments(), assets.loadPeople(), {}).jobs.filter((j) => !store.loadCache()[j.key]);
    expect(jobs).toHaveLength(2);
    await runner.executeJob(client, jobs[0]);
    await expect(runner.executeJob(client, jobs[1])).rejects.toBeInstanceOf(runner.BudgetStop);
    expect(starts).toBe(2);
  });

  it("writes results.csv with the requested columns", async () => {
    const { writeResultsCsv } = await import("./csv");
    const file = writeResultsCsv(Object.values(store.loadCache()));
    const [header, row] = readFileSync(file, "utf8").trim().split("\n");
    expect(header).toContain("person_file,framing");
    expect(header).toContain("photo_type");
    expect(header).toContain("output_w,output_h");
    expect(row).toContain("kurti.jpg,kurti,upper_body,upper_body,hanger,asha,asha-full.jpg,full,0,success");
  });
});
