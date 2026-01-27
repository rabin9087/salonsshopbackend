import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { 
  authMiddleware, 
  AuthenticatedRequest, 
  isSuperAdmin,
  isSalonStaff,
} from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/bookings
 * List bookings
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId, status, dateFrom, dateTo, date, page = '1', limit = '20' } = req.query;

  const pageNum = Math.max(1, parseInt(page as string));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit as string)));
  const skip = (pageNum - 1) * limitNum;

  const where: any = {};

  // 1. Permissions Logic
  if (!isSuperAdmin(req)) {
    const userSalonIds = req.user!.salonMemberships.map(m => m.salonId);
    
    if (salonId && userSalonIds.includes(salonId as string)) {
      where.salonId = salonId;
    } else if (userSalonIds.length > 0) {
      where.OR = [
        { userId: req.user!.userId },
        { salonId: { in: userSalonIds } },
      ];
    } else {
      where.userId = req.user!.userId;
    }
  } else if (salonId) {
    where.salonId = salonId;
  }

  // 2. Status Filter
  if (status && status !== 'all') {
    where.status = status;
  }

  // 3. FIXED Date Filtering
  if (date) {
    // Exact Day Match: From start of day to end of day
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    where.bookingDate = {
      gte: dayStart,
      lte: dayEnd,
    };
  } else if (dateFrom || dateTo) {
    // Range Match
    where.bookingDate = {};
    if (dateFrom) {
      where.bookingDate.gte = new Date(`${dateFrom}T00:00:00.000Z`);
    }
    if (dateTo) {
      where.bookingDate.lte = new Date(`${dateTo}T23:59:59.999Z`);
    }
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { bookingDate: 'desc' }, // Changed to bookingDate for chronological order
      include: {
        salon: { select: { id: true, name: true } },
        service: { select: { id: true, name: true, price: true } },
        user: { select: { id: true, fullName: true, phone: true } },
      },
    }),
    prisma.booking.count({ where }),
  ]);

  res.json({
    data: bookings,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  });
}));

/**
 * POST /api/bookings
 * Create a new booking
 */
router.post('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    salonId: z.string().uuid(),
    serviceId: z.string().uuid(),
    slotId: z.string().uuid(),
    bookingDate: z.string(), // "2026-04-04"
    startTime: z.string(),   // "14:30:00"
    notes: z.string().max(500).optional(),
  });

  const data = schema.parse(req.body);

  // 1. Validate salon is approved
  const salon = await prisma.salon.findUnique({ where: { id: data.salonId } });
  if (!salon || salon.status !== 'approved') {
    throw createError('Salon is not available for bookings', 400);
  }

  // 2. Validate service is active
  const service = await prisma.service.findUnique({ where: { id: data.serviceId } });
  if (!service || !service.isActive) {
    throw createError('Service is not available', 400);
  }

  // 3. Validate slot has capacity
  const slot = await prisma.slot.findUnique({ where: { id: data.slotId } });
  if (!slot || slot.bookedCount >= slot.capacity) {
    throw createError('Slot is not available', 400);
  }

  // 4. Check for duplicate booking
  const existing = await prisma.booking.findFirst({
    where: {
      userId: req.user!.userId,
      slotId: data.slotId,
      status: 'booked',
    },
  });
  if (existing) {
    throw createError('You already have a booking for this slot', 400);
  }

  // 5. Calculate startTime and endTime exactly
  const [startH, startM] = data.startTime.split(':').map(Number);
  const totalStartMinutes = startH * 60 + startM;
  const totalEndMinutes = totalStartMinutes + service.durationMinutes;

  const endH = Math.floor(totalEndMinutes / 60) % 24;
  const endM = totalEndMinutes % 60;

  // Use the "1970-01-01T...Z" format to ensure Prisma/Postgres treats it as a pure TIME
  const timeStartStr = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00Z`;
  const timeEndStr = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00Z`;

  // 6. Generate QR code
  const qrCode = `${crypto.randomBytes(4).toString('hex')}-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();

  // 7. Execute Transaction
  const [booking] = await prisma.$transaction([
    prisma.booking.create({
      data: {
        userId: req.user!.userId,
        salonId: data.salonId,
        serviceId: data.serviceId,
        slotId: data.slotId,
        // Normalize date to UTC midnight
        bookingDate: new Date(`${data.bookingDate}T00:00:00Z`),
        startTime: new Date(`1970-01-01T${timeStartStr}`),
        endTime: new Date(`1970-01-01T${timeEndStr}`),
        qrCode,
        notes: data.notes,
        status: 'booked',
      },
      include: {
        salon: { select: { name: true } },
        service: { select: { name: true, price: true } },
      },
    }),
    prisma.slot.update({
      where: { id: data.slotId },
      data: { bookedCount: { increment: 1 } },
    }),
  ]);

  // Only send the response ONCE at the end
  res.status(201).json({
    success: true,
    message: 'Booking created successfully',
    booking,
  });
}));

/**
 * GET /api/bookings/:bookingId
 * Get single booking details
 */
router.get('/:bookingId', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.bookingId },
    include: {
      salon: { select: { id: true, name: true } },
      service: { select: { id: true, name: true, price: true } },
      user: { select: { id: true, fullName: true, phone: true } },
    },
  });

  if (!booking) {
    throw createError('Booking not found', 404);
  }

  // Check permissions
  const isOwner = booking.userId === req.user!.userId;
  const isStaff = isSalonStaff(req, booking.salonId);
  const isAdmin = isSuperAdmin(req);

  if (!isOwner && !isStaff && !isAdmin) {
    throw createError('Access denied', 403);
  }

  res.json({ booking });
}));

/**
 * POST /api/bookings/:bookingId/cancel
 * Cancel a booking
 */
router.post('/:bookingId/cancel', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.bookingId },
  });

  if (!booking) {
    throw createError('Booking not found', 404);
  }

  // Check permissions
  const isOwner = booking.userId === req.user!.userId;
  const isStaff = isSalonStaff(req, booking.salonId);
  const isAdmin = isSuperAdmin(req);

  if (!isOwner && !isStaff && !isAdmin) {
    throw createError('Access denied', 403);
  }

  if (booking.status !== 'booked') {
    throw createError('Only booked appointments can be cancelled', 400);
  }

  const [updated] = await prisma.$transaction([
    prisma.booking.update({
      where: { id: booking.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
      },
    }),
    prisma.slot.update({
      where: { id: booking.slotId },
      data: { bookedCount: { decrement: 1 } },
    }),
  ]);

  res.json({
    success: true,
    message: 'Booking cancelled successfully',
    booking: updated,
  });
}));

/**
 * POST /api/bookings/:bookingId/complete
 * Complete a booking (check-in)
 */
router.post('/:bookingId/complete', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    qrCode: z.string().optional(),
    markNoShow: z.boolean().optional(),
  });

  const { markNoShow } = schema.parse(req.body);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.bookingId },
  });

  if (!booking) {
    throw createError('Booking not found', 404);
  }

  // Only staff or admin can complete
  if (!isSalonStaff(req, booking.salonId) && !isSuperAdmin(req)) {
    throw createError('Salon staff access required', 403);
  }

  if (booking.status !== 'booked') {
    throw createError('Only booked appointments can be completed', 400);
  }

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: markNoShow ? 'no_show' : 'completed',
      completedAt: new Date(),
      completedBy: req.user!.userId,
    },
  });

  res.json({
    success: true,
    message: markNoShow ? 'Booking marked as no-show' : 'Booking completed successfully',
    booking: updated,
  });
}));

/**
 * GET /api/bookings/qr/:qrCode
 * Get booking by QR code
 */
router.get('/qr/:qrCode', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const booking = await prisma.booking.findUnique({
    where: { qrCode: req.params.qrCode },
    include: {
      salon: { select: { id: true, name: true } },
      service: { select: { id: true, name: true, price: true } },
      user: { select: { id: true, fullName: true, phone: true } },
    },
  });

  if (!booking) {
    throw createError('Booking not found', 404);
  }

  // Only staff or admin can scan QR
  if (!isSalonStaff(req, booking.salonId) && !isSuperAdmin(req)) {
    throw createError('Access denied', 403);
  }

  res.json({ booking });
}));

export default router;
