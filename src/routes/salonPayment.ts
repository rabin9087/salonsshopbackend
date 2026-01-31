import prisma from "@/lib/prisma";
import { AuthenticatedRequest, authMiddleware, requireSuperAdmin } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";
import { PaymentStatus } from "@prisma/client";
import { Router } from "express";
import { z } from 'zod';

const router = Router();

// --- SCHEMAS ---
const createSalonPaymentSchema = z.object({
  salonId: z.string().min(1, "Salon ID is required"),
  amountPaid: z.number().positive("Amount must be greater than 0"),
  monthsPaid: z.number().int().min(1).default(1),
  screenshotUrl: z.string().url("Valid screenshot URL is required"),
});

const updateStatusSchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']),
});

// --- ROUTES ---

/**
 * @route   POST /api/salon-payments
 * @desc    Create a new payment proof (Salon Admin Only)
 */
router.post('/', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const validatedData = createSalonPaymentSchema.parse(req.body);
  const userId = req.user?.userId;

  // Verify User Role for this specific Salon
  const membership = await prisma.salonMembership.findFirst({
    where: {
      salonId: validatedData.salonId,
      userId: userId,
      role: 'salon_admin',
    },
  });

  if (!membership) {
    return res.status(403).json({ success: false, message: "Only Salon Admins can submit payments." });
  }

  const salonPayment = await prisma.salonPayment.create({
    data: {
      ...validatedData,
      status: 'pending',
    },
  });

  res.status(201).json({ success: true, data: salonPayment });
}));

/**
 * @route   GET /api/salon-payments/salon/:salonId
 * @desc    Get all payments for a specific salon (History)
 */
router.get('/:salonId', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { salonId } = req.params;
  const userId = req.user?.userId;

  // Ensure user has access to this salon
  const membership = await prisma.salonMembership.findFirst({
    where: { userId },
  });

  if (!membership) {
    return res.status(403).json({ success: false, message: "Access denied." });
  }

  const payments = await prisma.salonPayment.findMany({
    where: { salonId },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: payments });
}));

/**
 * @route   GET /api/salon-payments/pending
 * @desc    Get all pending payments across all salons (Super Admin Only)
 */
router.get('/pending', authMiddleware, requireSuperAdmin, asyncHandler(async (req: AuthenticatedRequest, res) => {
  // Logic: The requireSuperAdmin middleware already verified the role from the JWT
  
  const pendingPayments = await prisma.salonPayment.findMany({
    where: { 
      // Ensure you are using the enum value, not just a raw string
      status: 'pending' 
    },
    include: { 
      salon: { 
        select: { 
          name: true,
          city: true 
        } 
      } 
    },
    orderBy: { createdAt: 'asc' },
  });
  
console.log(pendingPayments)
  res.json({ success: true, data: pendingPayments });
}));

/**
 * @route   PATCH /api/salon-payments/:id/status
 * @desc    Verify or Reject a payment (Super Admin Only)
 */
router.patch('/:id/status', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
    const { status } = updateStatusSchema.parse(req.body);
    
    const userRole = await prisma.userRole.findFirst({
        where: {
        userId: req.user?.userId,
        role: "salon_admin",
        }
    })

  if (!userRole) {
    return res.status(403).json({ success: false, message: "Super Admin access required." });
  }

  const currentPayment = await prisma.salonPayment.findUnique({
    where: { id },
    include: { salon: true }
  });

  if (!currentPayment) {
    return res.status(404).json({ success: false, message: "Payment record not found." });
  }

  // Update Payment Status
  const updatedPayment = await prisma.salonPayment.update({
    where: { id },
    data: { 
      status: status as PaymentStatus,
      verifiedBy: userRole.userId
    },
  });

  // LOGIC: If verified, automatically extend the salon's nextDueDate
  if (status === 'verified') {
    const currentDueDate = currentPayment.salon.nextDueDate || new Date();
    const newDueDate = new Date(currentDueDate);
    newDueDate.setMonth(newDueDate.getMonth() + currentPayment.monthsPaid);

    await prisma.salon.update({
      where: { id: currentPayment.salonId },
      data: { nextDueDate: newDueDate }
    });
  }

  res.json({ 
    success: true, 
    message: `Payment marked as ${status}`, 
    data: updatedPayment 
  });
}));

/**
 * @route   DELETE /api/salon-payments/:id
 * @desc    Delete a payment (Only if pending or rejected)
 */
router.delete('/:id', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    
    const payment = await prisma.salonPayment.findUnique({ where: { id } });
    if (!payment) return res.status(404).json({ success: false, message: "Not found" });

    // Block deletion of verified payments to prevent accounting errors
    if (payment.status === 'verified') {
        return res.status(400).json({ success: false, message: "Cannot delete a verified payment record." });
    }

    await prisma.salonPayment.delete({ where: { id } });
    res.json({ success: true, message: "Record deleted." });
}));

export default router;