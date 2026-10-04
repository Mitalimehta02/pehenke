/**
 * Shrink a phone photo in the browser before upload (phone photos are 3-8 MB;
 * the server stores at most 1600 px anyway). Applies EXIF orientation via
 * createImageBitmap. Falls back to the original file if anything fails.
 */
export async function resizeForUpload(file: File, maxSide = 2048, quality = 0.9): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 2_500_000 && file.type === "image/jpeg") return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality));
  } catch {
    return file;
  }
}
