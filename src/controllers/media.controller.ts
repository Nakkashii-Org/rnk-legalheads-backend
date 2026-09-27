import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { logger } from "../lib/logger.js";
import { LICENCES, Media } from "../models/Media.js";
import { Person } from "../models/content/Person.js";
import { Publication } from "../models/content/Publication.js";
import { audit } from "../services/auth.js";
import { sniffImage, type ImageStorage } from "../services/images.js";

type Rec = Record<string, any>;
type Meta = { title: string; alt: string; decorative: boolean; credit: string; licence: (typeof LICENCES)[number] };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Reads and checks the details of one image; returns an error message or the clean details. */
function checkMeta(raw: unknown): Meta | string {
  const m = (raw && typeof raw === "object" ? raw : {}) as Rec;
  const meta = {
    title: str(m.title, 120),
    decorative: m.decorative === true,
    alt: m.decorative === true ? "" : str(m.alt, 250),
    credit: str(m.credit, 160),
    licence: str(m.licence, 20) as Meta["licence"],
  };
  if (!meta.title) return "Add a title.";
  if (!meta.decorative && !meta.alt) return "Add alt text, or mark the image as decorative.";
  if (!meta.credit) return "Add the creator or source.";
  if (!(LICENCES as readonly string[]).includes(meta.licence)) return "Choose the licence or consent basis.";
  return meta;
}

/** Where each image is used: people portraits and publication images. */
async function usage(): Promise<Map<string, string[]>> {
  const used = new Map<string, string[]>();
  const add = (id: unknown, label: string) => {
    if (typeof id !== "string" || !id) return;
    used.set(id, [...(used.get(id) ?? []), label]);
  };
  for (const p of await Person.find({ "portrait.mediaId": { $exists: true } }, { name: 1, "portrait.mediaId": 1 }).lean<Rec[]>())
    add(p.portrait?.mediaId, `Portrait of ${p.name}`);
  for (const p of await Publication.find({ "image.mediaId": { $exists: true } }, { title: 1, "image.mediaId": 1 }).lean<Rec[]>())
    add(p.image?.mediaId, p.title);
  return used;
}

const out = (m: Rec, usedBy: string[] = []) => ({
  id: String(m._id),
  title: m.title,
  alt: m.alt,
  decorative: m.decorative,
  credit: m.credit,
  licence: m.licence,
  url: m.url,
  contentType: m.contentType,
  bytes: m.bytes,
  width: m.width,
  height: m.height,
  uploadedBy: m.uploadedBy,
  createdAt: m.createdAt,
  usedBy,
});

/** Media library (C4): approved images with their source, licence and alt text. Every signed-in role may upload. */
export class MediaController {
  constructor(private readonly images: ImageStorage) {}

  /** GET /api/admin/media?q= → newest first, with where each image is used. */
  list = async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const filter = q ? { title: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {};
    const [items, used] = await Promise.all([Media.find(filter).sort({ createdAt: -1 }).limit(500).lean<Rec[]>(), usage()]);
    res.json({ items: items.map((m) => out(m, used.get(String(m._id)))) });
  };

  /** POST /api/admin/media (multipart: files + meta[i]) → every file is checked first; nothing is stored if one is wrong. */
  upload = async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) return void res.status(422).json({ errors: { files: "Choose at least one image." } });
    const body = (req.body ?? {}) as Rec;
    const errors: Record<string, string> = {};
    const checked = files.map((file, i) => {
      let meta: Meta | string;
      try {
        // Multer turns "meta[0]", "meta[1]"… into an array.
        const raw = Array.isArray(body.meta) ? body.meta[i] : body[`meta[${i}]`];
        meta = checkMeta(JSON.parse(String(raw ?? "{}")));
      } catch {
        meta = "The image details could not be read.";
      }
      const type = sniffImage(file.buffer);
      if (!type) errors[String(i)] = `${file.originalname}: not a JPG, PNG, WebP or AVIF image.`;
      else if (typeof meta === "string") errors[String(i)] = meta;
      return { file, type, meta };
    });
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const saved: Rec[] = [];
    for (const { file, type, meta } of checked) {
      const now = new Date();
      const key = `media/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomBytes(9).toString("base64url")}`;
      try {
        const stored = await this.images.put(key, file.buffer, type!);
        const media = await Media.create({ ...(meta as Meta), ...stored, storageKey: key, contentType: type, bytes: file.size, uploadedBy: req.user!.email });
        saved.push(media);
        await audit("media.uploaded", { actorId: req.user!.id, actorEmail: req.user!.email, target: `media/${media._id}`, detail: media.title });
      } catch (error) {
        logger.error("media.upload_failed", { error: (error as Error).message });
        return void res.status(502).json({
          error: "storage_failed",
          message: `${saved.length ? `${saved.length} image(s) were uploaded, but ` : ""}"${(meta as Meta).title}" could not be stored. Please try again.`,
        });
      }
    }
    res.status(201).json({ items: saved.map((m) => out(m.toObject())) });
  };

  /** PATCH /api/admin/media/:id → edit the details; the alt text is updated wherever the image is used. */
  update = async (req: Request, res: Response) => {
    const media = await Media.findById(String(req.params.id)).catch(() => null);
    if (!media) return void res.status(404).json({ error: "not_found" });
    const meta = checkMeta(req.body);
    if (typeof meta === "string") return void res.status(422).json({ errors: { meta } });
    media.set(meta);
    await media.save();
    const id = String(media._id);
    await Person.updateMany({ "portrait.mediaId": id }, { $set: { "portrait.alt": meta.alt } });
    await Publication.updateMany({ "image.mediaId": id }, { $set: { "image.alt": meta.alt } });
    await audit("media.updated", { actorId: req.user!.id, actorEmail: req.user!.email, target: `media/${id}`, detail: meta.title });
    res.json({ item: out(media.toObject()) });
  };

  /** DELETE /api/admin/media/:id → only by the uploader or an Administrator, and only when nothing uses it. */
  remove = async (req: Request, res: Response) => {
    const media = await Media.findById(String(req.params.id)).catch(() => null);
    if (!media) return void res.status(404).json({ error: "not_found" });
    if (!req.user!.roles.includes("admin") && media.uploadedBy !== req.user!.email)
      return void res.status(403).json({ error: "forbidden", message: "Only the person who uploaded this image, or an Administrator, can delete it." });
    const usedBy = (await usage()).get(String(media._id)) ?? [];
    if (usedBy.length)
      return void res.status(409).json({ error: "in_use", message: `This image is used by: ${usedBy.join(", ")}. Choose another image there first.` });
    try {
      await this.images.remove(media.storageKey);
    } catch (error) {
      // The record is still removed; a stray file in storage is harmless and is logged for clean-up.
      logger.error("media.remove_failed", { key: media.storageKey, error: (error as Error).message });
    }
    await media.deleteOne();
    await audit("media.deleted", { actorId: req.user!.id, actorEmail: req.user!.email, target: `media/${media._id}`, detail: media.title });
    res.json({ ok: true });
  };
}
