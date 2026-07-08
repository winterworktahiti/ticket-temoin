// Downscale and re-encode a photo client-side before it ever reaches the
// server. Phone camera photos can be several MB; keeping uploads small means
// faster transfers and a cheaper/faster server-side call to Qwen. Not needed
// to work around any platform limit here (this stack has normal outbound
// network access) -- just good practice.

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

export async function compressImageFile(file) {
  if (file.size < 700_000) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return file;

    return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    return file;
  }
}
