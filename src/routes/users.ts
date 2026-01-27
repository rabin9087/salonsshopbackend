import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { authMiddleware, AuthenticatedRequest, isSuperAdmin } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/users/me
 * Get current user profile
 */
router.get('/me', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
  });

  if (!user) {
    throw createError('User not found', 404);
  }

  res.json({ user });
}));

/**
 * PUT /api/users/me
 * Update current user profile
 */
router.put('/me', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    fullName: z.string().min(2).max(100).optional(),
    phone: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
    avatarUrl: z.string().url().optional(),
  });

  const data = schema.parse(req.body);

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data,
  });

  res.json({ success: true, user });
}));

/**
 * GET /api/users/me/roles
 * Get current user's roles
 */
router.get('/me/roles', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const roles = await prisma.userRole.findMany({
    where: { userId: req.user!.userId },
    select: { role: true },
  });

  res.json({ roles });
}));

/**
 * GET /api/users/me/memberships
 * Get current user's salon memberships
 */
router.get('/me/memberships', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const memberships = await prisma.salonMembership.findMany({
    where: { userId: req.user!.userId },
    include: {
      salon: { select: { name: true } },
    },
  });

  res.json({
    memberships: memberships.map(m => ({
      salonId: m.salonId,
      role: m.role,
      salonName: m.salon.name,
    })),
  });
}));

/**
 * GET /api/users
 * List users (admin or salon staff only)
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId, search, page = '1', limit = '20' } = req.query;

  // Non-super admins must specify salonId
  if (!isSuperAdmin(req) && !salonId) {
    throw createError('Salon ID required for non-admin users', 400);
  }

  const pageNum = Math.max(1, parseInt(page as string));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit as string)));
  const skip = (pageNum - 1) * limitNum;

  const where: any = {};

  if (salonId) {
    // Get users who have bookings at this salon
    where.bookings = {
      some: { salonId: salonId as string },
    };
  }

  if (search) {
    where.OR = [
      { fullName: { contains: search as string, mode: 'insensitive' } },
      { phone: { contains: search as string } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  res.json({
    data: users,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  });
}));

/**
 * PUT /api/users/:userId
 * Update user (super admin only)
 */
router.put('/:userId', asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!isSuperAdmin(req)) {
    throw createError('Super admin access required', 403);
  }

  const schema = z.object({
    fullName: z.string().min(2).max(100).optional(),
    phone: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
    avatarUrl: z.string().url().optional(),
  });

  const data = schema.parse(req.body);

  const user = await prisma.user.update({
    where: { id: req.params.userId },
    data,
  });

  res.json({ success: true, user });
}));

/**
 * POST /api/users/roles
 * Add or remove user role
 */
router.post('/roles', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    userId: z.string().uuid(),
    role: z.enum(['super_admin', 'salon_admin', 'salon_staff', 'user']),
    action: z.enum(['add', 'remove']),
    salonId: z.string().uuid().optional(),
  });

  const { userId, role, action, salonId } = schema.parse(req.body);

  // Only super admin can assign super_admin role
  if (role === 'super_admin' && !isSuperAdmin(req)) {
    throw createError('Only super admins can manage super_admin role', 403);
  }

  if (action === 'add') {
    await prisma.userRole.create({
      data: { userId, role },
    });
  } else {
    await prisma.userRole.deleteMany({
      where: { userId, role },
    });
  }

  res.json({ success: true, message: `Role ${action === 'add' ? 'added' : 'removed'}` });
}));

export default router;
