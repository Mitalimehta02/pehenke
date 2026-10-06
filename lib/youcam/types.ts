// Request/response shapes transcribed from the YouCam OpenAPI spec embedded in
// https://yce.perfectcorp.com/document/index.html. Fields the spec mentions
// only in prose are marked optional and commented.

/** Feature path segments used in /file/{feature} and /task/{feature}. */
export type Feature = "cloth-v3" | "skin-tone-analysis" | LookFeature;

/** Complete-the-look features (SPIKE.md): 1 unit per success, input must be a head-and-shoulders crop. */
export type LookFeature = "makeup-vto" | "2d-vto/necklace" | "2d-vto/earring";

/** Every successful response is wrapped like this. */
export interface Envelope<T> {
  status: number;
  data: T;
}

/** Error body on 4xx/5xx (`error` is absent on some codes, e.g. 401). */
export interface ApiErrorBody {
  status?: number;
  error?: string;
  error_code?: string;
}

// ---------- Files ----------

export interface CreateFileRequest {
  files: Array<{
    content_type: string;
    file_name: string;
    /** bytes; must be under 10MB */
    file_size: number;
  }>;
}

export interface UploadInstruction {
  method: string;
  url: string;
  headers: Record<string, string | number>;
}

export interface CreatedFile {
  content_type: string;
  file_name: string;
  file_id: string;
  requests: UploadInstruction[];
}

export interface CreateFileResponseData {
  files: CreatedFile[];
}

// ---------- Tasks ----------

export type TaskStatus = "running" | "success" | "error";

export interface StartTaskResponseData {
  /** queryable for 24 hours */
  task_id: string;
}

/**
 * Documented task error values. The docs' error tables list extra codes not in
 * the enum (e.g. error_invalid_ref), so this stays an open string.
 */
export type TaskError =
  | "exceed_max_filesize"
  | "invalid_parameter"
  | "error_download_image"
  | "error_download_mask"
  | "error_decode_image"
  | "error_decode_mask"
  | "error_nsfw_content_detected"
  | "error_no_face"
  | "error_pose"
  | "error_face_parsing"
  | "error_inference"
  | "exceed_nsfw_retry_limits"
  | "error_upload"
  | "unknown_internal_error"
  | (string & {});

export interface TaskStatusData<R> {
  task_status: TaskStatus;
  error?: TaskError | null;
  error_message?: string;
  results?: R;
  /** Mentioned in prose ("poll at given polling_interval"), absent from schema. */
  polling_interval?: number;
}

// ---------- AI Clothes V3 ----------

export type GarmentCategory = "upper_body" | "lower_body" | "full_body" | "shoes" | "auto";

type ClothesSource = { src_file_id: string } | { src_file_url: string };
type ClothesReference = { ref_file_id: string } | { ref_file_url: string };

export type ClothesV3Request = ClothesSource &
  ClothesReference & {
    garment_category: GarmentCategory;
    /** default true; only affects full_body / lower_body */
    change_shoes?: boolean;
  };

export interface ClothesV3Result {
  /** valid for 2 hours */
  url: string;
}

// ---------- Skin Tone Analysis ----------

export type FaceAngleStrictness = "strict" | "high" | "medium" | "low" | "flexible";

export type SkinToneRequest = ({ src_file_id: string } | { src_file_url: string }) & {
  /** default "high" */
  face_angle_strictness_level?: FaceAngleStrictness;
};

export interface SkinToneResult {
  face_quality?: {
    has_face?: boolean;
    area?: string;
    frontal?: string;
    lighting?: string;
    faceangle?: string;
  };
  color?: {
    eye_color?: string;
    eye_color_name?: "Amber" | "Brown" | "Green" | "Blue" | "Gray" | "Other";
    lip_color?: string;
    eyebrow_color?: string;
    /** "#rrggbb" */
    skin_color?: string;
    hair_color?: string;
    hair_color_name?: "Auburn" | "Black" | "Blonde" | "Brown" | "Grey/White" | "Red";
  };
}

// ---------- Units ----------

export interface FeatureCostSku {
  description: string;
  /** units consumed per `proc_unit` */
  amount: number;
  unit: "result_image" | "second";
  proc_unit: number;
  /** full URL of the task endpoint that consumes this sku */
  run_task_url: string;
}

/** Note: this endpoint wraps its payload in `result`, not `data`. */
export interface FeatureCostResponse {
  status: number;
  result: {
    next_token: string | null;
    skus: FeatureCostSku[];
  };
}

export interface UnitBalanceEntry {
  id: number;
  type: "ApiSubsToken" | "ApiPaygToken";
  amount: number;
  /** unix ms */
  expiry: number;
}

/** Note: this endpoint wraps its payload in `results`. */
export interface UnitBalanceResponse {
  status: number;
  results: UnitBalanceEntry[];
}
