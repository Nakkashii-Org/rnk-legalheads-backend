import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { CloudinaryStorage } from "./storage.js";

/** Public images for the website (media library). Resumes never go here. */
export interface ImageStorage {
  put(key: string, body: Buffer, contentType: string): Promise<{ url: string; width?: number; height?: number }>;
  remove(key: string): Promise<void>;
}

export const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" } as const;
export type ImageType = keyof typeof IMAGE_TYPES;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The real file type from the first bytes (the browser's claimed type and the file name are not trusted). */
export function sniffImage(body: Buffer): ImageType | undefined {
  if (body.length < 12) return undefined;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (body.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(body.toString("latin1", 8, 12))) return "image/avif";
  return undefined;
}

/** Cloudinary public image delivery; sizes and formats are chosen per page through the URL. */
export class CloudinaryImages implements ImageStorage {
  constructor(
    private readonly cfg: Config["storage"]["cloudinary"],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(action: "upload" | "destroy", params: Record<string, string>, file?: { body: Buffer; type: string; name: string }) {
    const form = new FormData();
    if (file) form.append("file", new Blob([new Uint8Array(file.body)], { type: file.type }), file.name);
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append("api_key", this.cfg.apiKey);
    form.append("signature", CloudinaryStorage.sign(params, this.cfg.apiSecret));
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.cloudinary.com/v1_1/${this.cfg.cloudName}/image/${action}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`Cloudinary request failed: ${(error as Error).name}`);
    }
    const data = (await response.json().catch(() => ({}))) as { secure_url?: string; width?: number; height?: number; error?: { message?: string } };
    if (!response.ok) throw new Error(`Cloudinary ${action} failed (${response.status}): ${data.error?.message ?? "unknown"}`);
    return data;
  }

  async put(key: string, body: Buffer, contentType: string) {
    const params = { public_id: key, timestamp: String(Math.floor(Date.now() / 1000)) };
    const data = await this.call("upload", params, { body, type: contentType, name: key.split("/").pop()! });
    if (!data.secure_url) throw new Error("Cloudinary upload returned no address");
    return { url: data.secure_url, width: data.width, height: data.height };
  }

  async remove(key: string) {
    await this.call("destroy", { public_id: key, timestamp: String(Math.floor(Date.now() / 1000)) });
  }
}

/** Development only: files under a git-ignored folder, served by the backend at /api/media-files/. */
export class LocalImages implements ImageStorage {
  constructor(readonly root: string) {}
  private target(key: string) {
    const target = path.resolve(this.root, key);
    if (!target.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return target;
  }
  async put(key: string, body: Buffer, contentType: string) {
    const file = `${key}.${IMAGE_TYPES[contentType as ImageType]}`;
    const target = this.target(file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return { url: `/api/media-files/${file}` };
  }
  async remove(key: string) {
    for (const ext of Object.values(IMAGE_TYPES)) await rm(this.target(`${key}.${ext}`), { force: true });
  }
}

/** S3/R2 buckets here are private (resumes), so website images need Cloudinary. */
export class NoImages implements ImageStorage {
  async put(): Promise<never> {
    throw new Error("Image uploads need STORAGE_DRIVER=cloudinary");
  }
  async remove() {}
}

export function createImageStorage(config: Config): ImageStorage {
  switch (config.storage.driver) {
    case "cloudinary":
      return new CloudinaryImages(config.storage.cloudinary);
    case "local":
      return new LocalImages(path.join(config.storage.localDir, "media"));
    default:
      return new NoImages();
  }
}
