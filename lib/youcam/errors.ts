/** Non-2xx response from the YouCam API. */
export class YouCamApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly httpStatus: number,
    readonly errorCode: string | undefined,
    detail: string | undefined,
  ) {
    super(`YouCam ${method} ${path} -> ${httpStatus}${errorCode ? ` ${errorCode}` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "YouCamApiError";
  }
}

/**
 * Our local poll deadline passed while the task was still running. The task is
 * NOT lost: keep its id and poll again later, or it may time out server-side
 * and still be charged.
 */
export class TaskPollTimeoutError extends Error {
  constructor(
    readonly feature: string,
    readonly taskId: string,
    readonly waitedMs: number,
  ) {
    super(`Task ${feature}/${taskId} still running after ${Math.round(waitedMs / 1000)}s`);
    this.name = "TaskPollTimeoutError";
  }
}

/**
 * The server no longer knows the task (InvalidTaskId / TaskTimeout). Per the
 * docs its units may still have been consumed and its result is unreachable.
 */
export class TaskLostError extends Error {
  constructor(
    readonly feature: string,
    readonly taskId: string,
    readonly errorCode: string,
  ) {
    super(`Task ${feature}/${taskId} lost: ${errorCode}`);
    this.name = "TaskLostError";
  }
}
