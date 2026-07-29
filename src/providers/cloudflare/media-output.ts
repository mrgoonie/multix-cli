import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "../../core/errors.js";
import { getOutputDir } from "../../core/output-dir.js";

function destination(filename: string, output?: string): string {
  return output ? path.resolve(output) : path.join(getOutputDir(), filename);
}

export function saveBytes(bytes: Uint8Array, filename: string, output?: string): string {
  const dest = destination(filename, output);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return dest;
}

export function saveBase64Image(image: string, output?: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image) || image.length === 0 || image.length % 4 !== 0) {
    throw new ProviderError("Cloudflare returned an invalid image result", "Cloudflare");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(image, "base64");
  } catch {
    throw new ProviderError("Cloudflare returned an invalid image result", "Cloudflare");
  }
  if (bytes.length === 0)
    throw new ProviderError("Cloudflare returned an empty image result", "Cloudflare");
  return saveBytes(bytes, `cloudflare_image_${Date.now()}.jpg`, output);
}
