import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { authMiddleware, AuthenticatedRequest, isSalonAdmin, isSuperAdmin } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router({ mergeParams: true });

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/salons/:salonId/staff
 * Get all staff members for a salon
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId } = req.params;

  // Only salon admin or super admin can view staff
  if (!isSalonAdmin(req, salonId) && !isSuperAdmin(req)) {
    throw createError('Salon admin access required', 403);
  }

  const staff = await prisma.salonMembership.findMany({
    where: { salonId },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          phone: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ data: staff });
}));

/**
 * POST /api/salons/:salonId/staff
 * Add a staff member to salon
 */
router.post('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId } = req.params;

  // Only salon admin can add staff
  if (!isSalonAdmin(req, salonId) && !isSuperAdmin(req)) {
    throw createError('Salon admin access required', 403);
  }

  const schema = z.object({
    phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
    role: z.enum(['salon_admin', 'salon_staff']),
  });

  const { phone, role } = schema.parse(req.body);

  // Find user by phone
  const user = await prisma.user.findUnique({
    where: { phone },
  });

  if (!user) {
    throw createError('User not found. They must create an account first.', 404);
  }

  // Check if already a member
  const existingMembership = await prisma.salonMembership.findFirst({
    where: { salonId, userId: user.id },
  });

  if (existingMembership) {
    throw createError('User is already a staff member', 400);
  }

  // Create membership
  const membership = await prisma.salonMembership.create({
    data: {
      salonId,
      userId: user.id,
      role,
      invitedBy: req.user!.userId,
    },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          phone: true,
        },
      },
    },
  });

  res.status(201).json({ success: true, data: membership });
}));

/**
 * DELETE /api/salons/:salonId/staff/:membershipId
 * Remove a staff member from salon
 */
router.delete('/:membershipId', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId, membershipId } = req.params;

  // Only salon admin can remove staff
  if (!isSalonAdmin(req, salonId) && !isSuperAdmin(req)) {
    throw createError('Salon admin access required', 403);
  }

  const membership = await prisma.salonMembership.findFirst({
    where: { id: membershipId, salonId },
  });

  if (!membership) {
    throw createError('Staff member not found', 404);
  }

  // Prevent removing yourself if you're the only admin
  if (membership.userId === req.user!.userId && membership.role === 'salon_admin') {
    const adminCount = await prisma.salonMembership.count({
      where: { salonId, role: 'salon_admin' },
    });
    
    if (adminCount <= 1) {
      throw createError('Cannot remove the only admin. Assign another admin first.', 400);
    }
  }

  await prisma.salonMembership.delete({
    where: { id: membershipId },
  });

  res.json({ success: true, message: 'Staff member removed' });
}));

export default router;
