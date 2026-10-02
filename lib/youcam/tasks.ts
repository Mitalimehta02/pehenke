import { TaskLostError, TaskPollTimeoutError, YouCamApiError } from "./errors";
import type { Http } from "./http";
import type { Envelope, Feature, StartTaskResponseData, TaskStatusData } from "./types";

/** Units a successful task of this feature costs; null if unknown. */
export type UnitCostLookup = (feature: Feature) => number | null;

/**
 * Starts a task and returns its id. Never retried on network errors or 5xx:
 * the task may already exist, and a retry could pay twice. Persist the id
 * before polling — an abandoned task still charges.
 */
export async function startTask(http: Http, feature: Feature, body: object): Promise<string> {
  const res = await http.request<Envelope<StartTaskResponseData>>("POST", `/s2s/v2.0/task/${feature}`, {
    body,
    retry: "rate-limit-only",
    note: "start",
  });
  return res.data.task_id;
}

/** One status check. Units are logged on the call that first reports success. */
export async function getTask<R>(http: Http, feature: Feature, taskId: string, unitCost: UnitCostLookup): Promise<TaskStatusData<R>> {
  try {
    const res = await http.request<Envelope<TaskStatusData<R>>>("GET", `/s2s/v2.0/task/${feature}/${encodeURIComponent(taskId)}`, {
      retry: "safe",
      unitsFor: (b) => (b.data.task_status === "success" ? unitCost(feature) : 0),
      note: "poll",
    });
    return res.data;
  } catch (err) {
    if (err instanceof YouCamApiError && (err.errorCode === "InvalidTaskId" || err.errorCode === "TaskTimeout")) {
      throw new TaskLostError(feature, taskId, err.errorCode);
    }
    throw err;
  }
}

export interface PollOptions {
  /** give up locally after this long (the task keeps running server-side). Default 5 min. */
  timeoutMs?: number;
  /** first wait before checking. Default 1s. */
  initialDelayMs?: number;
  /** cap on the wait between checks. Default 5s. */
  maxDelayMs?: number;
  /** growth per check. Default 1.5. */
  factor?: number;
  onPoll?: (status: TaskStatusData<unknown>, elapsedMs: number) => void;
}

/**
 * Polls until success or error, with exponential backoff. Returns the final
 * status (check `task_status`); throws TaskPollTimeoutError if still running
 * at the deadline, or TaskLostError if the server no longer knows the task.
 */
export async function pollTask<R>(http: Http, feature: Feature, taskId: string, unitCost: UnitCostLookup, opts: PollOptions = {}): Promise<TaskStatusData<R>> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const factor = opts.factor ?? 1.5;
  let delay = opts.initialDelayMs ?? 1_000;
  const started = Date.now();

  for (;;) {
    await http.sleep(delay);
    const status = await getTask<R>(http, feature, taskId, unitCost);
    const elapsed = Date.now() - started;
    opts.onPoll?.(status as TaskStatusData<unknown>, elapsed);
    if (status.task_status !== "running") return status;
    if (elapsed >= timeoutMs) throw new TaskPollTimeoutError(feature, taskId, elapsed);

    // The docs say to poll "at given polling_interval" but never define the
    // field or its unit. Honour it if it appears and looks like seconds.
    const hinted = typeof status.polling_interval === "number" && status.polling_interval > 0 && status.polling_interval <= 60 ? status.polling_interval * 1000 : 0;
    delay = Math.max(hinted, Math.min(delay * factor, maxDelayMs));
    // Don't sleep far past the deadline: one last check right at it.
    delay = Math.min(delay, Math.max(250, timeoutMs - elapsed));
  }
}

/** Deletes a task and its output files (needed for consent/deletion later). */
export async function deleteTask(http: Http, taskId: string): Promise<void> {
  await http.request("POST", "/s2s/v2.0/task/delete", { body: { task_id: taskId }, retry: "safe" });
}
