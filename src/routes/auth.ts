import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { otpRateLimiter } from '../middleware/rateLimit.js';
import { prisma } from '../lib/prisma.js';
import { sendOtp } from '../lib/twilio.js';
import { Gender } from '@prisma/client';

interface JWTPayload {
  userId: string;
  phone: string | null;
  roles: string[];
  salonMemberships: {
    salonId: string;
    role: string;
  }[];
}
  

const router = Router();

// Validation schemas
const sendOtpSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Invalid phone number format (E.164 required)'),
});

const verifyOtpSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
  otp: z.string().length(6, 'OTP must be 6 digits'),
  token: z.string().min(1, 'Session token required'),
  mode: z.enum(['login', 'signup']),
  fullName: z.string().min(2).max(100).optional(),
  email: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().email('Invalid email format').toLowerCase().optional()
  ),
gender: z.enum(['male', 'female', 'other']).optional(),});

/**
 * POST /api/auth/send-otp
 * Send OTP to phone number
 */
router.post('/send-otp', otpRateLimiter, asyncHandler(async (req, res) => {
  const { phone } = sendOtpSchema.parse(req.body);
  console.log("phone", phone)
  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await bcrypt.hash(otp, 10);
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Store OTP session
  await prisma.otpSession.create({
    data: {
      phone,
      otpHash,
      sessionToken,
      expiresAt,
      ipAddress: req.ip,
    },
  });

  // Send OTP via Twilio (or mock in development)
  if (process.env.NODE_ENV === 'development') {
      console.log(`📱 DEV OTP for ${phone}: ${otp}`);
  } else {
      await sendOtp(phone, otp);
  }

  res.json({
    success: true,
    token: sessionToken,
    message: 'OTP sent successfully',
    expiresIn: 600,
  });
}));

/**
 * POST /api/auth/verify-otp
 * Verify OTP and authenticate user
 */
router.post('/verify-otp', asyncHandler(async (req, res) => {
  const { phone, otp, token, mode, fullName, gender, email } = verifyOtpSchema.parse(req.body);

  // Find OTP session
  const session = await prisma.otpSession.findUnique({
    where: { sessionToken: token },
  });

  if (!session || session.phone !== phone) {
    throw createError('Invalid session', 400, 'INVALID_SESSION');
  }

  if (session.used) {
    throw createError('OTP already used', 400, 'OTP_USED');
  }

  if (session.expiresAt < new Date()) {
    throw createError('OTP expired', 400, 'OTP_EXPIRED');
  }

  if (session.attempts >= 3) {
    throw createError('Too many attempts', 400, 'TOO_MANY_ATTEMPTS');
  }

  // Verify OTP
  const isValid = await bcrypt.compare(otp, session.otpHash);

  if (!isValid) {
    // Increment attempts
    await prisma.otpSession.update({
      where: { id: session.id },
      data: { attempts: session.attempts + 1 },
    });
    throw createError('Invalid OTP', 400, 'INVALID_OTP');
  }

  // Mark session as used
  await prisma.otpSession.update({
    where: { id: session.id },
    data: { used: true },
  });

  // Find or create user
  if (!phone) {
    throw createError('Phone number required', 400, 'USER_EXISTS');
  }
  let user = await prisma.user.findUnique({ where: {phone } });

  if (mode === 'signup') {
    if (user) {
      throw createError('User already exists. Please login instead.', 400, 'USER_EXISTS');
    }
    if (!fullName) {
      throw createError('Full name required for signup', 400, 'NAME_REQUIRED');
    }
const emailValue = (email && email.trim() !== "") ? email.toLowerCase() : null;
    user = await prisma.user.create({
      data: {
        phone,
        fullName,
        roles: {
          create: { role: 'user' },
        },
        gender: gender as Gender,
        email: emailValue || undefined,
      },
    });
  } else {
    if (!user) {
      throw createError('User not found. Please signup first.', 404, 'USER_NOT_FOUND');
    }
  }

  // Get user roles and memberships
  const [roles, memberships] = await Promise.all([
    prisma.userRole.findMany({ where: { userId: user.id } }),
    prisma.salonMembership.findMany({ where: { userId: user.id } }),
  ]);

  // Generate JWT
  interface UserRole {
    role: string;
  }

  interface SalonMembership {
    salonId: string;
    role: string;
  }

  interface JWTTokenPayload {
    userId: string;
    phone: string;
    roles: string[];
    salonMemberships: SalonMembership[];
  }

  const jwtToken = jwt.sign({
      userId: user.id,
      phone: user.phone || '', // Default to an empty string if user.phone is null
      roles: roles.map((r: UserRole) => r.role),
      salonMemberships: memberships.map((m: SalonMembership) => ({ salonId: m.salonId, role: m.role })),
    } satisfies JWTTokenPayload,
    process.env.JWT_SECRET as string, // Ensure JWT_SECRET is defined and typed
    { expiresIn: '60d' } // Ensure options are correctly structured
  );

  res.json({
    success: true,
    user: {
      id: user.id,
      phone: user.phone,
      fullName: user.fullName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    token: jwtToken,
    message: mode === 'signup' ? 'Account created successfully' : 'Login successful',
  });
}));

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {

  console.log(req.user?.userId)
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
  });

  if (!user) {
    throw createError('User not found', 404, 'USER_NOT_FOUND');
  }

  res.json({
    user: {
      id: user.id,
      phone: user.phone,
      fullName: user.fullName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
  });
}));

/**
 * POST /api/auth/logout
 * Logout user (client-side token removal)
 */
router.post('/logout', authMiddleware, (req, res) => {
  // For stateless JWT, logout is handled client-side
  // Optionally implement token blacklist here
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

export default router;
