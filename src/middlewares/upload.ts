import type { RequestHandler } from "express";
import multer from "multer";
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
