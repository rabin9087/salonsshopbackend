import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import path from "path";
import mime from "mime-types";
import multer, { FileFilterCallback } from "multer";
import { Request } from "express";

// 1. Initialize client OUTSIDE the function for better performance/connection pooling
// It will automatically look for process.env.AWS_REGION, etc., 
// but we pass them explicitly for clarity.
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

export const uploadToS3 = async (
  file: Express.Multer.File, // Correct type reference
  keyPrefix: string
): Promise<string> => {
  try {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const region = process.env.AWS_REGION;

    if (!bucketName || !region) {
      throw new Error("AWS_S3_BUCKET_NAME or AWS_REGION is not defined");
    }

    // 2. Determine file metadata
    const ext = path.extname(file.originalname);
    // Lookup mime type by extension, fallback to file's own mimetype
    const mimeType = mime.lookup(ext) || file.mimetype || "application/octet-stream";
    
    // 3. Create a unique Key (path in S3)
    const key = `${keyPrefix}/${Date.now()}-${randomUUID()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: mimeType,
      // Optional: ACL: 'public-read' // Only if your bucket allows public ACLs
    });

    // 4. Execute upload
    await s3.send(command);

    // 5. Construct URL
    // Standard format: https://bucket-name.s3.region.amazonaws.com/key
    return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;

  } catch (err: any) {
    console.error("S3 Upload Error Detail:", err.message);
    throw new Error(`S3 Upload Failed: ${err.message}`);
  }
};

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
];

export const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback
  ) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(new Error("Only JPG, PNG, or PDF files are allowed"));
    } else {
      cb(null, true);
    }
  },
});
