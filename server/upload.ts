import { Express } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { requireAuth } from "./auth";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

export function setupUpload(app: Express) {
  app.post("/api/upload", requireAuth, async (req: any, res) => {
    try {
      if (req.user.role !== "admin") {
        return res.status(403).json({ message: "غير مصرح" });
      }

      const { image } = req.body;
      if (!image) {
        return res.status(400).json({ message: "الصورة مطلوبة" });
      }

      const result = await cloudinary.uploader.upload(image, {
        folder: "tasleem-products",
        transformation: [
          { width: 800, height: 800, crop: "limit" },
          { quality: "auto" },
        ],
      });

      res.json({ url: result.secure_url, public_id: result.public_id });
    } catch (e: any) {
      console.error("Upload error:", e);
      res.status(500).json({ message: e.message || "فشل رفع الصورة" });
    }
  });

  app.delete("/api/upload/:publicId", requireAuth, async (req: any, res) => {
    try {
      if (req.user.role !== "admin") {
        return res.status(403).json({ message: "غير مصرح" });
      }

      await cloudinary.uploader.destroy(req.params.publicId);
      res.json({ message: "تم حذف الصورة" });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
