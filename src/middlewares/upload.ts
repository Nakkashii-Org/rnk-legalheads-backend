import type { RequestHandler } from "express";
import multer from "multer";
import { IMAGE_MAX_BYTES } from "../services/images.js";
import { RESUME_MAX_BYTES } from "../validation/careers.js";

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RESUME_MAX_BYTES, files: 1, fields: 20, fieldSize: 8 * 1024, parts: 25 },
}).single("resume");

/**
 * Parses the multipart careers form. The resume is held in memory only long enough to check it
 * and upload it to private storage. Upload problems become the same answers the form expects.
 */
export const receiveResume: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) return void res.status(415).json({ error: "multipart_required" });
  resumeUpload(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE")
      return void res.status(422).json({ errors: { resume: "The resume must be 5 MB or smaller." } });
    res.status(400).json({ error: "invalid_form" });
  });
};

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: 10, fields: 20, fieldSize: 4 * 1024, parts: 30 },
}).array("files", 10);

/** Parses a media-library upload (up to 10 images of 10 MB each), held in memory only while it's checked and stored. */
export const receiveImages: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) return void res.status(415).json({ error: "multipart_required" });
  imageUpload(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE")
      return void res.status(422).json({ errors: { files: "Each image must be 10 MB or smaller." } });
    if (error instanceof multer.MulterError && (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE"))
      return void res.status(422).json({ errors: { files: "Upload at most 10 images at a time." } });
    res.status(400).json({ error: "invalid_form" });
  });
};
