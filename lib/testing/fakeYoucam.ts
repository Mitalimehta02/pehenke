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
  /** dev only: return a real render for these inputs if known (else the synthetic one) */
  renderFrom?: (src: Uint8Array, ref: Uint8Array) => Promise<Buffer | null>;
}

export class FakeYouCam {
  readonly starts: Array<{ taskId: string; body: Record<string, unknown> }> = [];
  readonly deletes: string[] = [];
  private files = new Map<string, Uint8Array>();
  private tasks = new Map<string, { src: string; ref: string; polls: number }>();
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
      const task = this.tasks.get(url.pathname.slice(1).replace(/\.jpg$/, ""))!;
      const real = await this.opts.renderFrom?.(this.files.get(task.src)!, this.files.get(task.ref)!);
      return new Response(new Uint8Array(real ?? (await this.render(this.files.get(task.src)!))), { status: 200, headers: { "content-type": "image/jpeg" } });
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
      this.tasks.set(taskId, { src: body.src_file_id, ref: body.ref_file_id, polls: 0 });
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
