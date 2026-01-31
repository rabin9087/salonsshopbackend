import { Router } from "express";
import authRoutes from './auth.js';
import userRoutes from './users.js';
import salonRoutes from './salons.js';
import bookingRoutes from './bookings.js';
import salonStaffRoutes from './salonStaff.js';
import uploadRoutes from './upload.js';
import salonPaymentRoutes from './salonPayment.js';

const router = Router();

// API Routes
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/salons', salonRoutes);
router.use('/salons/:salonId/staff', salonStaffRoutes);
router.use('/bookings', bookingRoutes);
router.use('/upload', uploadRoutes);
router.use('/salon-payments', salonPaymentRoutes);

export default router; 