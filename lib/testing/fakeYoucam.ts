import sharp from "sharp";
import { YouCamClient, type CallLogger } from "../youcam";

/**
 * In-memory stand-in for the YouCam API (upload, cloth-v3 task, poll,
 * download, delete), so tests never spend units.
 */
export interface FakeYouCamOptions {
  /** polls answering "running" before success. Default 1 */
  runningPolls?: number;
  /** "ok" renders a changed torso; "unchanged" returns the person photo (bad render) */
  render?: "ok" | "unchanged";
  /** make the next task start fail with this HTTP status */
  failStartWith?: number;
  /** finish tasks with this task error instead of success */
  taskError?: string;
  /** answer polls with InvalidTaskId (task lost) */
  lose?: boolean;
  /** look features ("makeup-vto", "2d-vto/necklace", "2d-vto/earring") whose tasks end in a task error */
  failFeatures?: string[];
  /** dev only: return a real render for these inputs if known (else the synthetic one) */
  renderFrom?: (src: Uint8Array, ref: Uint8Array) => Promise<Buffer | null>;
}

export class FakeYouCam {
  readonly starts: Array<{ taskId: string; body: Record<string, unknown> }> = [];
  readonly deletes: string[] = [];
  private files = new Map<string, Uint8Array>();
  private tasks = new Map<string, { src: string; ref: string; polls: number; feature: string }>();
  private n = 0;

  constructor(public opts: FakeYouCamOptions = {}) {}

  client(logger: CallLogger = () => {}): YouCamClient {
    return new YouCamClient({ apiKey: "test", baseUrl: "https://api.fake", fetchImpl: this.fetch, logger, sleep: async () => {} });
  }

  private json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    if (url.host === "upload.fake") {
      this.files.set(url.pathname.slice(1), new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (url.host === "cdn.fake") {
      const task = this.tasks.get(url.pathname.slice(1).replace(/\.(jpg|png)$/, ""))!;
      if (task.feature !== "cloth-v3") {
        return new Response(new Uint8Array(await this.renderLook(task.feature, this.files.get(task.src)!)), { status: 200, headers: { "content-type": "image/png" } });
      }
      const real = await this.opts.renderFrom?.(this.files.get(task.src)!, this.files.get(task.ref)!);
      return new Response(new Uint8Array(real ?? (await this.render(this.files.get(task.src)!))), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    const look = /^\/s2s\/v2\.0\/(file|task)\/(makeup-vto|2d-vto\/necklace|2d-vto\/earring)(?:\/(.+))?$/.exec(url.pathname);
    if (look && look[1] === "file" && method === "POST") {
      const id = `file-${++this.n}`;
      return this.json(200, { status: 200, data: { files: [{ file_id: id, requests: [{ method: "PUT", url: `https://upload.fake/${id}`, headers: {} }] }] } });
    }
    if (look && look[1] === "task" && !look[3] && method === "POST") {
      if (this.opts.failStartWith) {
        const st = this.opts.failStartWith;
        this.opts.failStartWith = undefined;
        return this.json(st, { status: st, error_code: st < 500 ? "InvalidParameters" : "Boom" });
      }
      const body = JSON.parse(String(init?.body));
      // the live API rejects null for optional jewellery fields (SPIKE.md)
      const params = body.object_infos?.[0]?.parameter ?? {};
      if (Object.values(params).some((v) => v === null)) return this.json(400, { status: 400, error_code: "InvalidParameters" });
      const taskId = `task-${++this.n}`;
      this.tasks.set(taskId, { src: body.src_file_id, ref: body.ref_file_ids?.[0] ?? "", polls: 0, feature: look[2] });
      this.starts.push({ taskId, body: { ...body, feature: look[2] } });
      return this.json(200, { status: 200, data: { task_id: taskId } });
    }
    if (look && look[1] === "task" && look[3] && method === "GET") {
      const taskId = decodeURIComponent(look[3]);
      const task = this.tasks.get(taskId);
      if (!task || this.opts.lose) return this.json(400, { status: 400, error_code: "InvalidTaskId" });
      if (task.polls++ < (this.opts.runningPolls ?? 1)) return this.json(200, { status: 200, data: { task_status: "running" } });
      if (this.opts.taskError || this.opts.failFeatures?.includes(task.feature)) {
        return this.json(200, { status: 200, data: { task_status: "error", error: this.opts.taskError ?? "error_no_face" } });
      }
      return this.json(200, { status: 200, data: { task_status: "success", results: { url: `https://cdn.fake/${taskId}.png` } } });
    }
    if (url.pathname === "/s2s/v2.0/file/cloth-v3" && method === "POST") {
      const id = `file-${++this.n}`;
      return this.json(200, { status: 200, data: { files: [{ file_id: id, requests: [{ method: "PUT", url: `https://upload.fake/${id}`, headers: {} }] }] } });
    }
    if (url.pathname === "/s2s/v2.0/task/cloth-v3" && method === "POST") {
      if (this.opts.failStartWith) {
        const s = this.opts.failStartWith;
        this.opts.failStartWith = undefined;
        return this.json(s, { status: s, error_code: s < 500 ? "InvalidParameters" : "Boom" });
      }
      const body = JSON.parse(String(init?.body));
      const taskId = `task-${++this.n}`;
      this.tasks.set(taskId, { src: body.src_file_id, ref: body.ref_file_id, polls: 0, feature: "cloth-v3" });
      this.starts.push({ taskId, body });
      return this.json(200, { status: 200, data: { task_id: taskId } });
    }
    const poll = /^\/s2s\/v2\.0\/task\/cloth-v3\/(.+)$/.exec(url.pathname);
    if (poll && method === "GET") {
      const taskId = decodeURIComponent(poll[1]);
      const task = this.tasks.get(taskId);
      if (!task || this.opts.lose) return this.json(400, { status: 400, error_code: "InvalidTaskId" });
      if (task.polls++ < (this.opts.runningPolls ?? 1)) return this.json(200, { status: 200, data: { task_status: "running" } });
      if (this.opts.taskError) return this.json(200, { status: 200, data: { task_status: "error", error: this.opts.taskError } });
      return this.json(200, { status: 200, data: { task_status: "success", results: { url: `https://cdn.fake/${taskId}.jpg` } } });
    }
    if (url.pathname === "/s2s/v2.0/task/delete" && method === "POST") {
      const { task_id } = JSON.parse(String(init?.body));
      if (!this.tasks.delete(task_id)) return this.json(400, { status: 400, error_code: "InvalidTaskId" });
      this.deletes.push(task_id);
      return this.json(200, { status: 200 });
    }
    throw new Error(`FakeYouCam: unexpected ${method} ${url}`);
  }) as typeof fetch;

  /**
   * A look step: the input crop with one small patch drawn on it (lossless PNG, same
   * size, nothing else changed), like the live API. Each feature draws in its own place.
   */
  private async renderLook(feature: string, crop: Uint8Array): Promise<Buffer> {
    const meta = await sharp(crop).metadata();
    const w = meta.width!;
    const h = meta.height!;
    const box = (x: number, y: number, bw: number, bh: number, color: string) => ({
      input: { create: { width: Math.round(w * bw), height: Math.round(h * bh), channels: 3 as const, background: color } },
      left: Math.round(w * x),
      top: Math.round(h * y),
    });
    const patches =
      feature === "makeup-vto"
        ? [box(0.44, 0.33, 0.12, 0.03, "#b02a1e")]
        : feature === "2d-vto/necklace"
          ? [box(0.36, 0.46, 0.28, 0.04, "#c9a227")]
          : [box(0.33, 0.27, 0.03, 0.06, "#d43f8d"), box(0.64, 0.27, 0.03, 0.06, "#d43f8d")];
    return sharp(crop).removeAlpha().composite(patches).png().toBuffer();
  }

  /** "Try-on": recolour the middle of the person photo, or return it unchanged. */
  private async render(person: Uint8Array): Promise<Buffer> {
    if (this.opts.render === "unchanged") return Buffer.from(person);
    const meta = await sharp(person).metadata();
    const w = meta.width!;
    const h = meta.height!;
    const torso = await sharp({ create: { width: Math.round(w * 0.7), height: Math.round(h * 0.75), channels: 3, background: "#b0124a" } }).png().toBuffer();
    return sharp(person).composite([{ input: torso, left: Math.round(w * 0.15), top: Math.round(h * 0.18) }]).jpeg().toBuffer();
  }
}
