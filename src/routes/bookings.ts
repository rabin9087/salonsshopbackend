import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { 
  authMiddleware, 
  AuthenticatedRequest, 
  isSuperAdmin,
  isSalonStaff,
  optionalAuth,
} from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { sendBookingConfirmation } from '@/lib/twilio.js';

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
        staff: { select: { id: true, fullName: true, phone: true } },
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
router.post('/', optionalAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  // 1. Validation
  const schema = z.object({
    salonId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Salon ID format"),
    serviceId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Service ID format"),
    slotId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Slot ID format"),
    staffId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Slot ID format").optional(),
    bookingDate: z.string(), 
    startTime: z.string(),   
    notes: z.string().max(500).optional(),
  });

  const data = schema.parse(req.body);
  const userId = req.user?.userId;

  if (!userId) throw createError('Authentication required', 401);

  // 2. Optimized Parallel Lookups
  // We fetch everything in one go to reduce latency
  const [user, salon, service, slot] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.salon.findUnique({ 
      where: { id: data.salonId },
      include: { 
        memberships: { 
          take: 1, 
          include: { user: { select: { phone: true } } } 
        } 
      }
    }),
    prisma.service.findUnique({ where: { id: data.serviceId } }),
    prisma.slot.findUnique({ where: { id: data.slotId } })
  ]);

  // 3. Robust Validation Checks
  if (!user) throw createError('User not found', 404);
  if (!salon || salon.status !== 'approved') throw createError('Salon unavailable', 400);
  if (!service || !service.isActive) throw createError('Service unavailable', 400);
  if (!slot || slot.bookedCount >= slot.capacity) throw createError('Slot full', 400);

  // 4. Time Calculation
  const startDateTime = new Date(`${data.bookingDate}T${data.startTime.slice(0, 5)}:00Z`);
  if (isNaN(startDateTime.getTime())) throw createError('Invalid date/time', 400);

  const endDateTime = new Date(startDateTime.getTime() + service.durationMinutes * 60000);
  const qrCode = crypto.randomBytes(8).toString('hex').toUpperCase();

  // 5. Atomic Transaction
  const [booking] = await prisma.$transaction([
    prisma.booking.create({
      data: {
        userId,
        salonId: data.salonId,
        serviceId: data.serviceId,
        slotId: data.slotId,
        staffId: data.staffId || null,
        bookingDate: new Date(`${data.bookingDate}T00:00:00Z`),
        startTime: startDateTime,
        endTime: endDateTime,
        qrCode,
        notes: data.notes,
        status: 'booked',
      },
      include: {
        salon: { select: { name: true } },
        service: { select: { name: true, price: true } }
      },
    }),
    prisma.slot.update({
      where: { id: data.slotId },
      data: {
        bookedCount: { increment: 1 },
        staffId: data.staffId  },
    }),
  ]);

  // 6. Background SMS Notification
  // We don't 'await' this so the user gets their response faster
  const salonAdminPhone = salon.memberships[0]?.user?.phone as string;
  const formattedDate = new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(startDateTime)); 
  const confirmationTask = async () => {
    try {
      const payload = {
        phone: user.phone!,
        customerName: user.fullName,
        dateTime: startDateTime,
        salonName: salon.name,
        adminPhone: salonAdminPhone
      };

      if (process.env.NODE_ENV === 'development') {
        console.log('📱 [DEV SMS]:', payload);
        console.log(formattedDate)
      } else {
        await sendBookingConfirmation(payload);
      }
    } catch (err) {
      console.error('SMS Background Task Failed:', err);
    }
  };

  confirmationTask(); // Execute in background

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
router.post('/:bookingId/cancel', optionalAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
 
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

  if (booking.status !== 'booked' && booking.status !== 'in_progress') {
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
 * POST /api/bookings/:bookingId/complete
 * Complete a booking (check-in)
 */
router.patch('/:bookingId/update', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    serviceStarted: z.boolean().optional(),
    serviceId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    slotId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    bookingDate: z.string().optional(), // Expecting ISO string or YYYY-MM-DD
  });

  const data = schema.parse(req.body);
  const { bookingId } = req.params;

  // 1. Fetch current booking
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
  });

  if (!booking) {
    throw createError('Booking not found', 404);
  }

  // 2. Security: Only staff or super-admin
  if (!isSalonStaff(req, booking.salonId) && !isSuperAdmin(req)) {
    throw createError('Unauthorized: Salon staff access required', 403);
  }

  // 3. Build dynamic update object
  const updatePayload: any = {};

  // Handle Service Start Logic
  if (data.serviceStarted) {
    if (booking.status !== 'booked') {
      throw createError('Service can only be started for "booked" appointments', 400);
    }
    updatePayload.status = 'in_progress';
    updatePayload.serviceStarted = new Date();
  }

  // Handle Rescheduling / Updates
  if (data.serviceId) updatePayload.serviceId = data.serviceId;
  if (data.slotId) updatePayload.slotId = data.slotId;
  if (data.bookingDate) updatePayload.bookingDate = new Date(data.bookingDate);

  // 4. Update Slot Count if slotId changed
  if (data.slotId && data.slotId !== booking.slotId) {
    await prisma.$transaction([
      // Decrement old slot
      prisma.slot.update({
        where: { id: booking.slotId },
        data: { bookedCount: { decrement: 1 } }
      }),
      // Increment new slot
      prisma.slot.update({
        where: { id: data.slotId },
        data: { bookedCount: { increment: 1 } }
      }),
      // Update booking
      prisma.booking.update({
        where: { id: bookingId },
        data: updatePayload
      })
    ]);
  } else {
    // Standard update
    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: updatePayload,
    });
    
    return res.json({
      success: true,
      message: data.serviceStarted ? 'Service has started' : 'Booking updated successfully',
      booking: updated,
    });
  }

  res.json({ success: true, message: 'Booking updated with new slot' });
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
