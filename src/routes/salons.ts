import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { 
  authMiddleware, 
  optionalAuth,
  AuthenticatedRequest, 
  isSuperAdmin,
  isSalonAdmin,
  isSalonStaff,
} from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import slugify from 'slugify';
import { upload, uploadToS3 } from '@/lib/aws.js';

const router = Router();

// Validation schemas
const createSalonSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(1000).optional(),
  address: z.string().min(5).max(200),
  city: z.string().min(2).max(100),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  websiteURL: z.string().optional(),
  facebookPage: z.string().optional(),
  instagramPage: z.string().optional(),
  whatsAppNumber: z.string().optional(),
  contractAmount: z.number().optional(),
  nextDueDate: z.coerce.date().optional(),
  operatingHours: z.record(z.object({
    open: z.string(),
    close: z.string(),
    closed: z.boolean(),
  })).optional(),
});

/**
 * GET /api/salons
 * List salons with filters
 */
router.get('/', optionalAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { status, city, search, page = '1', limit = '20', includeOwn } = req.query;

  const pageNum = Math.max(1, parseInt(page as string));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit as string)));
  const skip = (pageNum - 1) * limitNum;

  const where: any = {};

  // Non-super admins can only see approved salons (plus their own pending)
  if (!isSuperAdmin(req)) {
    if (includeOwn === 'true' && req.user) {
      where.OR = [
        { status: 'approved' },
        { createdBy: req.user.userId },
      ];
    } else {
      where.status = 'approved';
    }
  } else if (status) {
    where.status = status;
  }

  if (city) {
    where.city = { contains: city as string, mode: 'insensitive' };
  }

  if (search) {
    where.AND = [
      where.AND || {},
      {
        OR: [
          { name: { contains: search as string, mode: 'insensitive' } },
          { description: { contains: search as string, mode: 'insensitive' } },
        ],
      },
    ];
  }

  const [salons, total] = await Promise.all([
    prisma.salon.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.salon.count({ where }),
  ]);

  // Hide contact info based on permissions
  const sanitizedSalons = salons.map(salon => {
    const canViewContact = 
      isSalonStaff(req, salon.id) || 
      isSuperAdmin(req);

    return {
      ...salon,
      phone: canViewContact ? salon.phone : undefined,
      email: canViewContact ? salon.email : undefined,
    };
  });

  res.json({
    data: sanitizedSalons,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  });
}));

/**
 * GET /api/salons/:salonId
 * Get single salon details
 */
router.get('/:salonId', optionalAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const salon = await prisma.salon.findUnique({
    where: { id: req.params.salonId },
  });

  if (!salon) {
    throw createError('Salon not found', 404);
  }

  // Non-super admins can only see approved salons (or their own)
  if (!isSuperAdmin(req) && salon.status !== 'approved') {
    if (!req.user || salon.createdBy !== req.user.userId) {
      throw createError('Salon not found', 404);
    }
  }

  const canViewContact = 
    isSalonStaff(req, salon.id) || 
    isSuperAdmin(req);

  res.json({
    salon: {
      ...salon,
      phone: canViewContact ? salon.phone : undefined,
      email: canViewContact ? salon.email : undefined,
      facebookPage: canViewContact ? salon.facebookPage : undefined,
      instagramPage: canViewContact ? salon.instagramPage : undefined,
      whatsAppNumber: canViewContact ? salon.whatsAppNumber : undefined,
    },
  });
}));

 /* GET /api/salons/name/:slug
 * Get single salon details
 */

router.get('/name/:slug', optionalAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {

  const { slug } = req.params;

  if (!slug) {
    throw createError('Slug is required', 400);
  }

  const salon = await prisma.salon.findFirst({
    where: { slug: req.params.slug },
  });

  console.log(salon)

  if (!salon) {
    throw createError('Salon not found', 404);
  }

  // Non-super admins can only see approved salons (or their own)
  if (!isSuperAdmin(req) && salon.status !== 'approved') {
    if (!req.user || salon.createdBy !== req.user.userId) {
      throw createError('Salon not found', 404);
    }
  }

  const canViewContact = 
    isSalonStaff(req, salon.id) || 
    isSuperAdmin(req);

  res.json({
    salon: {
      ...salon,
      phone: canViewContact ? salon.phone : undefined,
      email: canViewContact ? salon.email : undefined,
    },
  });
}));

/**
 * POST /api/salons
 * Create a new salon
 */
router.post('/', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const data = createSalonSchema.parse(req.body);

  const defaultHours = {
    monday: { open: '09:00', close: '18:00', closed: false },
    tuesday: { open: '09:00', close: '18:00', closed: false },
    wednesday: { open: '09:00', close: '18:00', closed: false },
    thursday: { open: '09:00', close: '18:00', closed: false },
    friday: { open: '09:00', close: '18:00', closed: false },
    saturday: { open: '10:00', close: '16:00', closed: false },
    sunday: { open: '10:00', close: '16:00', closed: true },
  };

  const salonName = data.name

  const slug = slugify(salonName, {
  replacement: '-',  // replace spaces with replacement character, defaults to `-`
  remove: /[*+~.()'"!:@]/g, // remove characters that match regex, defaults to `undefined`
  lower: true,      // convert to lower case, defaults to `false`
  strict: true,     // strip special characters except replacement, defaults to `false`
  trim: true         // trim leading and trailing replacement chars, defaults to `true`
  });
  
  const salon = await prisma.salon.create({
    data: {
      ...data,
      operatingHours: data.operatingHours || defaultHours,
      createdBy: req.user!.userId,
      status: 'pending',
      slug
    },
  });


  // Add creator as salon admin
  await prisma.salonMembership.create({
    data: {
      userId: req.user!.userId,
      salonId: salon.id,
      role: 'salon_admin',
    },
  });

  res.status(201).json({
    success: true,
    message: 'Salon created successfully',
    salon,
  });
}));

/**
 * PUT /api/salons/:salonId
 * Update salon details
 */
router.put('/:salonId', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const salonId = req.params.salonId;
    console.log(salonId)

  if (!isSalonAdmin(req, salonId)) {
    throw createError('You do not have permission to update this salon', 403);
  }

  const updateSchema = z.object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(1000).optional(),
    address: z.string().min(5).max(200).optional(),
    city: z.string().min(2).max(100).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    websiteURL: z.string().url().optional().or(z.literal('')),
    facebookPage: z.string().url().optional().or(z.literal('')),
    instagramPage: z.string().url().optional().or(z.literal('')),
    // WhatsApp is usually a phone string, not a URL
    whatsAppNumber: z.string().optional().or(z.literal('')),
    contractAmount: z.number().optional(),
    nextDueDate: z.coerce.date().optional(),
    imageUrl: z.string().url().optional().nullable(),
    operatingHours: z.record(z.object({
      open: z.string(),
      close: z.string(),
      closed: z.boolean(),
    })).optional(),
    defaultSlotCapacity: z.number().min(1).max(50).optional(),
  });

  // Log body for debugging if validation fails

  try {
    const data = updateSchema.parse(req.body);
    const salon = await prisma.salon.update({
      where: { id: salonId },
      data,
    });

    res.json({
      success: true,
      message: 'Salon updated successfully',
      salon,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: err.errors.map(e => ({ field: e.path[0], message: e.message }))
      });
    }
    throw err;
  }
}));

/**
 * POST /api/salons/:salonId/approve
 * Approve, reject, or suspend a salon
 */
router.post('/:salonId/approve', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!isSuperAdmin(req)) {
    throw createError('Super admin access required', 403);
  }

  const schema = z.object({
    action: z.enum(['approve', 'reject', 'suspend']),
    reason: z.string().max(500).optional(),
  });

  const { action, reason } = schema.parse(req.body);

  const statusMap = {
    approve: 'approved',
    reject: 'rejected',
    suspend: 'suspended',
  } as const;

  const salon = await prisma.salon.update({
    where: { id: req.params.salonId },
    data: {
      status: statusMap[action],
      approvedBy: action === 'approve' ? req.user!.userId : undefined,
      approvedAt: action === 'approve' ? new Date() : undefined,
    },
  });

  res.json({
    success: true,
    message: `Salon ${action}d successfully`,
    salon,
  });
}));

/**
 * GET /api/salons/:salonId/services
 * Get services for a salon
 */
router.get('/:salonId/services', optionalAuth, asyncHandler(async (req, res) => {
  const services = await prisma.service.findMany({
    where: {
      salonId: req.params.salonId,
      isActive: true,
    },
    orderBy: { name: 'asc' },
  });

  res.json({ services });
}));

/**
 * GET /api/salons/:salonId/services
 * Get services for a salon
 */
router.post('/:salonId/services', optionalAuth, asyncHandler(async (req, res) => {
  const {name, price, description, durationMinutes } = req.body
  const services = await prisma.service.create({
    data: {
      name,
      description,
      durationMinutes,
      salonId: req.params.salonId,
      price
    }
  });

  res.json({ services });
}));

router.post('/image', authMiddleware, upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res) => {
    if (!req.file) {
      throw createError('No file uploaded', 400);
    }

    const { type } = req.body;
    console.log("req.body", type, req.body)
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
      // else if (type === "salons") {
      //    await prisma.salon.update(
      //     {
      //       where: { id: req.user!.userId },
      //       data: { imageUrl: url }
      //     })
      // }
      
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

/**
 * PUT /api/salons/:salonId/services/:serviceId
 * Update a service
 */
router.put('/:salonId/services/:serviceId', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId, serviceId } = req.params;

  if (!isSalonAdmin(req, salonId)) {
    throw createError('Salon admin access required', 403);
  }

  const schema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    price: z.number().min(0).optional(),
    durationMinutes: z.number().min(5).optional(),
    showPrice: z.boolean().optional(),
    isActive: z.boolean().optional(),
  });

  const data = schema.parse(req.body);

  const service = await prisma.service.update({
    where: { id: serviceId, salonId },
    data,
  });

  res.json({ success: true, service });
}));

/**
 * DELETE /api/salons/:salonId/services/:serviceId
 * Delete a service
 */
router.delete('/:salonId/services/:serviceId', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId, serviceId } = req.params;

  if (!isSalonAdmin(req, salonId)) {
    throw createError('Salon admin access required', 403);
  }

  await prisma.service.delete({
    where: { id: serviceId, salonId },
  });

  res.json({ success: true, message: 'Service deleted' });
}));

/**
 * GET /api/salons/:salonId/slots
 * Get available slots for a date
 */
router.get('/:salonId/slots', asyncHandler(async (req, res) => {
  const { date } = req.query;

  if (!date) {
    throw createError('Date query parameter required', 400);
  }

  const slots = await prisma.slot.findMany({
    where: {
      salonId: req.params.salonId,
      date: new Date(date as string),
    },
    orderBy: { startTime: 'asc' },
  });

  res.json({
    slots: slots.map(slot => ({
      ...slot,
      startTime: slot.startTime.toISOString().substring(11, 19),
      endTime: slot.endTime.toISOString().substring(11, 19),
      available: slot.capacity - slot.bookedCount,
    })),
  });
}));

router.post('/:salonId/slots/generate', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const salonId = req.params.salonId;

  if (!isSalonAdmin(req, salonId)) {
    throw createError('Salon admin access required', 403);
  }

  const schema = z.object({
    startDate: z.string(), // Format: "YYYY-MM-DD"
    endDate: z.string(),   // Format: "YYYY-MM-DD"
    slotDurationMinutes: z.number().min(15).max(120),
    defaultCapacity: z.number().min(1).max(50),
  });

  const { startDate, endDate, slotDurationMinutes, defaultCapacity } = schema.parse(req.body);

  const salon = await prisma.salon.findUnique({ where: { id: salonId } });
  if (!salon) throw createError('Salon not found', 404);

  const operatingHours = salon.operatingHours as Record<string, { open: string; close: string; closed: boolean }>;
  const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const slotsToCreate = [];

  // Initialize loop variables
  let currentDate = new Date(startDate);
  const finalDate = new Date(endDate);

  while (currentDate <= finalDate) {
    const dayName = daysOfWeek[currentDate.getDay()];
    const config = operatingHours[dayName];

    // Check if salon is open this day and has valid strings
    if (config && !config.closed && config.open && config.close) {
      const [openH, openM] = config.open.split(':').map(Number);
      const [closeH, closeM] = config.close.split(':').map(Number);

      let currentTotalMinutes = openH * 60 + openM;
      const closingTotalMinutes = closeH * 60 + closeM;

      while (currentTotalMinutes + slotDurationMinutes <= closingTotalMinutes) {
        const startH = Math.floor(currentTotalMinutes / 60);
        const startM = currentTotalMinutes % 60;
        
        const endTotalMinutes = currentTotalMinutes + slotDurationMinutes;
        const endH = Math.floor(endTotalMinutes / 60);
        const endM = endTotalMinutes % 60;

        // Create ISO Strings for Time columns (using UTC Z to prevent shifts)
        const timeStart = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00Z`;
        const timeEnd = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00Z`;

        slotsToCreate.push({
          salonId,
          // Store date as midnight UTC for consistency
          date: new Date(`${currentDate.toISOString().split('T')[0]}T00:00:00Z`),
          startTime: new Date(`1970-01-01T${timeStart}`),
          endTime: new Date(`1970-01-01T${timeEnd}`),
          capacity: defaultCapacity,
        });

        currentTotalMinutes += slotDurationMinutes;
      }
    }
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const result = await prisma.slot.createMany({
    data: slotsToCreate,
    // skipDuplicates is not supported in this context, remove it
  });

  res.json({ 
    success: true, 
    slotsCreated: result.count,
    message: `Generated ${result.count} slots successfully.`
  });
}));
/**
 * PUT /api/salons/:salonId/slots/:slotId
 * Update a slot's capacity
 */
router.put('/:salonId/slots/:slotId', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId, slotId } = req.params;

  if (!isSalonAdmin(req, salonId)) {
    throw createError('Salon admin access required', 403);
  }

  const schema = z.object({
    capacity: z.number().min(1).max(50).optional(),
  });

  const data = schema.parse(req.body);

  const slot = await prisma.slot.update({
    where: { id: slotId, salonId },
    data,
  });

  res.json({ success: true, slot });
}));

/**
 * DELETE /api/salons/:salonId/slots/:slotId
 * Delete a slot (only if no bookings)
 */
router.delete('/:salonId/slots/:slotId', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId, slotId } = req.params;

  if (!isSalonAdmin(req, salonId)) {
    throw createError('Salon admin access required', 403);
  }

  const slot = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!slot) {
    throw createError('Slot not found', 404);
  }

  if (slot.bookedCount > 0) {
    throw createError('Cannot delete slot with existing bookings', 400);
  }

  await prisma.slot.delete({ where: { id: slotId } });

  res.json({ success: true, message: 'Slot deleted' });
}));

export default router;
