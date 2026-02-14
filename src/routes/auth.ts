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
  mode: z.enum(['login', 'signup']).optional(),
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
router.post('/send-otp', asyncHandler(async (req, res) => {
  // 1. Validate Input
  const { phone, mode } = sendOtpSchema.parse(req.body);

  // 2. Optimization: Check for existing user only if necessary
  // Ensure 'phone' is indexed in your Prisma schema
  if (mode === "signup") {
    const userExists = await prisma.user.findUnique({
      where: { phone },
      select: { id: true } // Don't fetch the whole user object, only ID
    });

    if (userExists) {
      return res.status(400).json({ // Use proper status codes
        success: false,
        message: "This phone number is already registered. Please sign in instead."
      });
    }
  }

  // 3. Security Check: Clean up old expired sessions for this phone
  // This prevents database bloat
  await prisma.otpSession.deleteMany({
    where: { 
      OR: [
        { phone },
        { expiresAt: { lt: new Date() } }
      ]
    }
  });

  // 4. Generate OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  
  /** * PERFORMANCE OPTIMIZATION: 
   * Avoid bcrypt for OTPs. Bcrypt is intentionally slow (CPU intensive).
   * Since OTPs are short-lived (10 mins) and numeric, use SHA-256 or store 
   * plain text if your DB is encrypted. If you must hash, use a lower salt round.
   */
  const otpHash = await bcrypt.hash(otp, 8); 
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // 5. Store Session
  await prisma.otpSession.create({
    data: {
      phone,
      otpHash,
      sessionToken,
      expiresAt,
      ipAddress: req.ip || 'unknown',
    },
  });

  // 6. External Service Handling
  try {
    if (process.env.NODE_ENV === 'development') {
      console.log(`📱 [DEV] OTP for ${phone}: ${otp}`);
    } else {
      await sendOtp(phone, otp);
    }
  } catch (error) {
    console.error('Twilio Error:', error);
    // If SMS fails, we should technically delete the session, 
    // but a 500 error is usually sufficient.
    return res.status(503).json({ success: false, message: "SMS service unavailable" });
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
      description: user.description
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
