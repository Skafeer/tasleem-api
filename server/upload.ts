import { v2 as cloudinary } from "cloudinary";
import { Express } from "express";
import { requireAuth } from "./auth";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "root",
  api_key: process.env.CLOUDINARY_API_KEY || "759944442924475",
  api_secret: process.env.CLOUDINARY_API_SECRET || "uvHvh9uRwhxjcMzocrPXpkNwaz8",
});

export function setupUpload(app: Express) {
  app.post("/api/upload", requireAuth, async (req: any, res) => {
    try {
      const { image } = req.body;
      if (!image) return res.status(400).json({ message: "لا توجد صورة" });

      const result = await cloudinary.uploader.upload(image, {
        folder: "tasleem-products",
        transformation: [{ width: 800, height: 800, crop: "limit", quality: "auto" }],
      });

      res.json({ url: result.secure_url, publicId: result.public_id });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/upload/:publicId", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      await cloudinary.uploader.destroy(req.params.publicId);
      res.json({ message: "تم الحذف" });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
