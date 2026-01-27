import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface JWTPayload {
  userId: string;
  phone: string;
  roles: ('super_admin' | 'salon_admin' | 'salon_staff' | 'user')[];
  salonMemberships: { salonId: string; role: 'salon_admin' | 'salon_staff' }[];
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
}

/**
 * Verify JWT and attach user to request
 */
export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return;
  }
}

/**
 * Optional auth - attaches user if token present, continues otherwise
 */
export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
    req.user = decoded;
  } catch {
    // Invalid token - continue without user
  }
  next();
}

/**
 * Check if user is super admin
 */
export function isSuperAdmin(req: AuthenticatedRequest): boolean {
  return req.user?.roles?.includes('super_admin') ?? false;
}

/**
 * Check if user is salon admin for a specific salon
 */
export function isSalonAdmin(req: AuthenticatedRequest, salonId: string): boolean {
  if (isSuperAdmin(req)) return true;
  return req.user?.salonMemberships?.some(
    m => m.salonId === salonId && m.role === 'salon_admin'
  ) ?? false;
}

/**
 * Check if user is salon staff (or admin) for a specific salon
 */
export function isSalonStaff(req: AuthenticatedRequest, salonId: string): boolean {
  if (isSuperAdmin(req)) return true;
  return req.user?.salonMemberships?.some(m => m.salonId === salonId) ?? false;
}

/**
 * Require super admin role
 */
export function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ success: false, error: 'Super admin access required' });
    return;
  }
  next();
}
