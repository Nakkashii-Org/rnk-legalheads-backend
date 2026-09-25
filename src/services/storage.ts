import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  return config.storage.driver === "s3" ? new S3Storage(config.storage.s3) : new LocalStorage(config.storage.localDir);
}
