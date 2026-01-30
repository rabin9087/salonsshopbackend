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
  // 1. Update Validation: MongoDB uses ObjectIds, not UUIDs
  const schema = z.object({
    salonId: z.string().refine((val) => /^[0-9a-fA-F]{24}$/.test(val), {
      message: "Invalid Salon ID format (must be ObjectId)",
    }),
    serviceId: z.string().refine((val) => /^[0-9a-fA-F]{24}$/.test(val), {
      message: "Invalid Service ID format",
    }),
    slotId: z.string().refine((val) => /^[0-9a-fA-F]{24}$/.test(val), {
      message: "Invalid Slot ID format",
    }),
    bookingDate: z.string(), // "2026-04-04"
    startTime: z.string(),   // "14:30"
    notes: z.string().max(500).optional(),
  });

  const data = schema.parse(req.body);

  // 2. Database lookups (unchanged logic, just uses ObjectIds now)
  const salon = await prisma.salon.findUnique({ where: { id: data.salonId } });
  if (!salon || salon.status !== 'approved') {
    throw createError('Salon is not available', 400);
  }

  const service = await prisma.service.findUnique({ where: { id: data.serviceId } });
  if (!service || !service.isActive) {
    throw createError('Service is not available', 400);
  }

  const slot = await prisma.slot.findUnique({ where: { id: data.slotId } });
  if (!slot || slot.bookedCount >= slot.capacity) {
    throw createError('Slot is fully booked', 400);
  }

  console.log(salon, service, slot, data)
  // 3. Time Calculation
  // MongoDB stores full Date objects. We combine the date and time strings.
  const timeString = data.startTime.length === 5 ? `${data.startTime}:00` : data.startTime;

// 2. Combine into a valid ISO string
const startISO = `${data.bookingDate}T${timeString}Z`; 

// 3. Create the Date object
const startDateTime = new Date(startISO);

// 4. Safety Check
if (isNaN(startDateTime.getTime())) {
  throw createError(`Invalid Date construction from: ${startISO}`, 400);
}

// 5. Calculate End Time
const endDateTime = new Date(startDateTime.getTime() + service.durationMinutes * 60000);

  // 4. Unique QR Code
  const qrCode = crypto.randomBytes(8).toString('hex').toUpperCase();

// Assume data.startTime is "14:30" and data.bookingDate is "2026-04-04"


// Safety check: If the strings were malformed, startDateTime will be "Invalid Date"
if (isNaN(startDateTime.getTime())) {
  throw createError('Invalid date or time format provided', 400);
}

  // 5. Execute Transaction
  // NOTE: MongoDB Atlas/Replica Sets are REQUIRED for this $transaction to work.
  const [booking] = await prisma.$transaction([
    prisma.booking.create({
      data: {
        userId: req.user!.userId,
        salonId: data.salonId,
        serviceId: data.serviceId,
        slotId: data.slotId,
        bookingDate: new Date(`${data.bookingDate}T00:00:00Z`),
        startTime: startDateTime,
        endTime: endDateTime,
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

  res.status(201).json({ success: true, booking });
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
