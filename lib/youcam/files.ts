import type { Http } from "./http";
import type { CreateFileRequest, CreateFileResponseData, Envelope, Feature } from "./types";

export interface UploadInput {
  bytes: Uint8Array;
  fileName: string;
  /** as sent in the docs' examples: "image/jpg" or "image/png" */
  contentType: string;
}

/** Max upload size from the docs (all image features here). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Two steps, both required: register the file (returns file_id + pre-signed
 * URL), then PUT the bytes there. Calling the AI task before the PUT finishes
 * gives 404 / unknown_internal_error per the docs. Uploads live 24h.
 */
export async function uploadFile(http: Http, feature: Feature, input: UploadInput, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (input.bytes.byteLength >= MAX_FILE_BYTES) {
    throw new Error(`${input.fileName} is ${input.bytes.byteLength} bytes; YouCam requires < 10MB`);
  }
  const req: CreateFileRequest = {
    files: [{ content_type: input.contentType, file_name: input.fileName, file_size: input.bytes.byteLength }],
  };
  const res = await http.request<Envelope<CreateFileResponseData>>("POST", `/s2s/v2.0/file/${feature}`, {
    body: req,
    retry: "safe",
  });
  const file = res.data.files[0];
  const put = file?.requests[0];
  if (!file || !put) throw new Error(`File API returned no upload instruction for ${input.fileName}`);

  // Let fetch set Content-Length from the body; pass the rest as given.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(put.headers)) {
    if (k.toLowerCase() !== "content-length") headers[k] = String(v);
  }
  const target = new URL(put.url);
  const started = Date.now();
  const upload = await fetchImpl(target, { method: put.method, headers, body: input.bytes as BodyInit });
  http.log({
    at: new Date().toISOString(),
    method: put.method,
    path: `${target.host} (pre-signed upload)`,
    httpStatus: upload.status,
    durationMs: Date.now() - started,
    units: 0,
    attempt: 1,
  });
  if (!upload.ok) {
    throw new Error(`Upload of ${input.fileName} failed: ${upload.status} ${(await upload.text()).slice(0, 200)}`);
  }
  return file.file_id;
}

/** Fetch a result image. Result URLs expire after ~2h, so call this as soon as a task succeeds. */
export async function downloadResult(http: Http, url: string, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Uint8Array; contentType: string }> {
  const target = new URL(url);
  const started = Date.now();
  const res = await fetchImpl(target);
  http.log({
    at: new Date().toISOString(),
    method: "GET",
    path: `${target.host} (result download)`,
    httpStatus: res.status,
    durationMs: Date.now() - started,
    units: 0,
    attempt: 1,
  });
  if (!res.ok) throw new Error(`Result download failed: ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "" };
}
