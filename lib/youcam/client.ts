import { getV1AccessToken } from "./auth";
import { getBalance, getFeatureCosts, unitsPerImage } from "./credit";
import { YouCamApiError } from "./errors";
import { CLOTHES_V3 } from "./features/clothesV3";
import { SKIN_TONE } from "./features/skinTone";
import { downloadResult, uploadFile, type UploadInput } from "./files";
import { Http, type HttpOptions } from "./http";
import { deleteTask, getTask, pollTask, startTask, type PollOptions } from "./tasks";
import type {
  ClothesV3Request,
  ClothesV3Result,
  Feature,
  FeatureCostSku,
  SkinToneRequest,
  SkinToneResult,
  TaskStatusData,
  UnitBalanceEntry,
} from "./types";

export interface RunHooks {
  /**
   * Called with the task id as soon as the task exists, before any polling.
   * Persist it here: an abandoned task still charges units.
   */
  onTaskStarted?: (taskId: string) => void | Promise<void>;
  poll?: PollOptions;
}

/** Typed YouCam client. Pure (no env access) so scripts, server and tests share it. */
export class YouCamClient {
  readonly http: Http;
  private readonly fetchImpl: typeof fetch;
  private costs: FeatureCostSku[] | undefined;
  private readonly apiKey: string;
  private readonly secretKey: string | undefined;
  private balanceAuth: "api-key" | "v1-token" | undefined;
  private v1Token: { token: string; expiresAt: number } | undefined;

  constructor(opts: HttpOptions & { secretKey?: string }) {
    this.http = new Http(opts);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiKey = opts.apiKey;
    this.secretKey = opts.secretKey;
  }

  // ---- units ----

  /** Free call. Cached for the client's lifetime; also used to log units per task. */
  async featureCosts(refresh = false): Promise<FeatureCostSku[]> {
    if (!this.costs || refresh) this.costs = await getFeatureCosts(this.http);
    return this.costs;
  }

  /** Units per successful task of this feature, from the cost table (null if unknown/ambiguous). */
  unitCost = (feature: Feature): number | null => (this.costs ? unitsPerImage(this.costs, feature) : null);

  /**
   * Unit balance. The endpoint is documented under V1 auth, so try the V2 API
   * key first and, on 401, a V1 access token (needs the secret key). Reports
   * which one worked; remembers it for later calls.
   */
  async balance(): Promise<{ total: number; entries: UnitBalanceEntry[]; auth: "api-key" | "v1-token" }> {
    if (this.balanceAuth !== "v1-token") {
      try {
        const b = await getBalance(this.http);
        this.balanceAuth = "api-key";
        return { ...b, auth: "api-key" };
      } catch (err) {
        if (!(err instanceof YouCamApiError && err.httpStatus === 401) || !this.secretKey) throw err;
      }
    }
    if (!this.secretKey) throw new Error("balance needs V1 token auth but no secret key is configured");
    if (!this.v1Token || this.v1Token.expiresAt < Date.now()) {
      // valid 2h per the docs; refresh 10 min early
      this.v1Token = { token: await getV1AccessToken(this.http, this.apiKey, this.secretKey), expiresAt: Date.now() + 110 * 60_000 };
    }
    const b = await getBalance(this.http, this.v1Token.token);
    this.balanceAuth = "v1-token";
    return { ...b, auth: "v1-token" };
  }

  // ---- generic ----

  upload(feature: Feature, input: UploadInput) {
    return uploadFile(this.http, feature, input, this.fetchImpl);
  }

  startTask(feature: Feature, body: object) {
    return startTask(this.http, feature, body);
  }

  getTask<R>(feature: Feature, taskId: string) {
    return getTask<R>(this.http, feature, taskId, this.unitCost);
  }

  pollTask<R>(feature: Feature, taskId: string, opts?: PollOptions) {
    return pollTask<R>(this.http, feature, taskId, this.unitCost, opts);
  }

  deleteTask(taskId: string) {
    return deleteTask(this.http, taskId);
  }

  download(url: string) {
    return downloadResult(this.http, url, this.fetchImpl);
  }

  /** start -> onTaskStarted -> poll. Make sure costs are loaded first so units get logged. */
  async run<R>(feature: Feature, body: object, hooks: RunHooks = {}): Promise<{ taskId: string; status: TaskStatusData<R> }> {
    const taskId = await this.startTask(feature, body);
    await hooks.onTaskStarted?.(taskId);
    const status = await this.pollTask<R>(feature, taskId, hooks.poll);
    return { taskId, status };
  }

  // ---- features ----

  readonly clothesV3 = {
    upload: (input: UploadInput) => this.upload(CLOTHES_V3, input),
    start: (req: ClothesV3Request) => this.startTask(CLOTHES_V3, req),
    poll: (taskId: string, opts?: PollOptions) => this.pollTask<ClothesV3Result>(CLOTHES_V3, taskId, opts),
    run: (req: ClothesV3Request, hooks?: RunHooks) => this.run<ClothesV3Result>(CLOTHES_V3, req, hooks),
  };

  readonly skinTone = {
    upload: (input: UploadInput) => this.upload(SKIN_TONE, input),
    start: (req: SkinToneRequest) => this.startTask(SKIN_TONE, req),
    poll: (taskId: string, opts?: PollOptions) => this.pollTask<SkinToneResult>(SKIN_TONE, taskId, opts),
    run: (req: SkinToneRequest, hooks?: RunHooks) => this.run<SkinToneResult>(SKIN_TONE, req, hooks),
  };
}
