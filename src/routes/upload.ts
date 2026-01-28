import { Router } from 'express';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { upload, uploadToS3 } from '../lib/aws.js';
import prisma from '@/lib/prisma.js';

const router = Router();

/**
 * POST /api/upload/image
 * Upload an image to S3
 */
router.post('/image', authMiddleware, upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res) => {
    if (!req.file) {
      throw createError('No file uploaded', 400);
    }

    const { type } = req.body;
    
    // Determine the S3 key prefix based on type
    let keyPrefix = 'uploads';
    if (type === 'avatar') {
      keyPrefix = `avatars/${req.user!.userId}`;
    } else if (type === 'salon') {
      keyPrefix = 'salons';
    }

    try {
      const url = await uploadToS3(req.file, keyPrefix);
      if (type === "avatar"){
        await prisma.user.update(
          {
            where: { id: req.user!.userId },
            data: { avatarUrl: url }
          })
      }
      res.json({
        success: true,
        url,
        message: 'Image uploaded successfully',
      });
    } catch (error: any) {
      console.error('S3 upload error:', error);
      throw createError(error.message || 'Failed to upload image', 500);
    }
  })
);

export default router;
