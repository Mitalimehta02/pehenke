import sharp from "sharp";

/**
 * Memory guard for small hosts (Render free: 512 MB). Measured on a 12 MP
 * photo: sharp's defaults add ~65 MB per operation, one libvips thread with
 * no cache ~28 MB; the production server itself sits at ~145-185 MB. Image
 * work therefore runs one operation at a time with sharp tightened.
 */
sharp.concurrency(1);
sharp.cache(false);

let queue: Promise<unknown> = Promise.resolve();

/** Run image work one operation at a time across the whole app. */
export function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}
