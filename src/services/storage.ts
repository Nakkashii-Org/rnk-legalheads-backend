import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";

/** Private file storage for resumes. Nothing stored here is publicly readable. */
export interface FileStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

/** Cloudflare R2, AWS S3 or any S3-compatible bucket. The bucket must not allow public access. */
export class S3Storage implements FileStorage {
  private readonly client: S3Client;
  constructor(private readonly cfg: Config["storage"]["s3"]) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType, ContentDisposition: "attachment" }),
    );
  }
}

/**
 * Cloudinary (works on the free plan). Resumes are uploaded as "raw" files with delivery type
 * "authenticated", so they cannot be opened from a public URL; access later needs a signed link.
 * Uses Cloudinary's signed Upload API directly (no SDK).
 */
export class CloudinaryStorage implements FileStorage {
  constructor(
    private readonly cfg: Config["storage"]["cloudinary"],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Cloudinary signature: SHA-1 of the sorted signed parameters followed by the API secret. */
  static sign(params: Record<string, string>, apiSecret: string) {
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return createHash("sha1").update(toSign + apiSecret).digest("hex");
  }

  async put(key: string, body: Buffer, contentType: string) {
    // For raw files the extension stays part of the public id, e.g. resumes/2026/09/RNK-XXXX.pdf
    const params = { public_id: key, timestamp: String(Math.floor(Date.now() / 1000)), type: "authenticated" };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(body)], { type: contentType }), key.split("/").pop());
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append("api_key", this.cfg.apiKey);
    form.append("signature", CloudinaryStorage.sign(params, this.cfg.apiSecret));

    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.cloudinary.com/v1_1/${this.cfg.cloudName}/raw/upload`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`Cloudinary request failed: ${(error as Error).name}`);
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Cloudinary upload failed (${response.status}): ${data.error?.message ?? "unknown"}`);
    }
  }
}

/** Development only (refused in production by the config): writes under a git-ignored folder. */
export class LocalStorage implements FileStorage {
  constructor(private readonly root: string) {}
  async put(key: string, body: Buffer, _contentType?: string) {
    const target = path.resolve(this.root, key);
    if (!target.startsWith(path.resolve(this.root))) throw new Error("Invalid storage key");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

export function createStorage(config: Config): FileStorage {
  switch (config.storage.driver) {
    case "s3":
      return new S3Storage(config.storage.s3);
    case "cloudinary":
      return new CloudinaryStorage(config.storage.cloudinary);
    default:
      return new LocalStorage(config.storage.localDir);
  }
}
