# Tidy Time Salon - Backend API Specification

## Overview

This document defines the REST API specification for the Tidy Time Salon backend built with Express.js and Node.js.

**Base URL:** `http://localhost:5000/api` (configurable via `VITE_API_URL`)

---

## Authentication

All authenticated endpoints require a Bearer token in the Authorization header:

```
Authorization: Bearer <jwt_token>
```

### JWT Token Structure

```typescript
interface JWTPayload {
  userId: string;
  phone: string;
  roles: ('super_admin' | 'salon_admin' | 'salon_staff' | 'user')[];
  salonMemberships: { salonId: string; role: 'salon_admin' | 'salon_staff' }[];
  iat: number;
  exp: number;
}
```

---

## Error Response Format

All error responses follow this structure:

```typescript
interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: object;
}
```

**Common HTTP Status Codes:**
- `400` - Bad Request (validation error)
- `401` - Unauthorized (missing/invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `429` - Too Many Requests (rate limited)
- `500` - Internal Server Error

---

## 1. Authentication Endpoints

### POST /api/auth/send-otp

Send OTP to a phone number for authentication.

**Auth Required:** No

**Rate Limit:** 20 requests per phone per hour, 50 per IP per hour

**Request Body:**
```typescript
{
  phone: string;  // E.164 format, e.g., "+14155551234"
}
```

**Success Response (200):**
```typescript
{
  success: true;
  token: string;     // Session token for OTP verification
  message: string;   // "OTP sent successfully"
  expiresIn: number; // Seconds until OTP expires (e.g., 600)
}
```

**Error Responses:**
- `400` - Invalid phone number format
- `429` - Rate limit exceeded

---

### POST /api/auth/verify-otp

Verify OTP and authenticate user (login or signup).

**Auth Required:** No

**Request Body:**
```typescript
{
  phone: string;              // E.164 format
  otp: string;                // 6-digit code
  token: string;              // Session token from send-otp
  mode: 'login' | 'signup';
  fullName?: string;          // Required for signup
}
```

**Success Response (200):**
```typescript
{
  success: true;
  user: User;
  token: string;    // JWT access token
  message: string;
}

interface User {
  id: string;           // UUID
  phone: string;
  fullName: string;
  email?: string;
  avatarUrl?: string;
  createdAt: string;    // ISO 8601
  updatedAt: string;
}
```

**Error Responses:**
- `400` - Invalid OTP, expired, or too many attempts
- `404` - User not found (login mode only)

---

### GET /api/auth/me

Get current authenticated user.

**Auth Required:** Yes

**Success Response (200):**
```typescript
{
  user: User;
}
```

---

### POST /api/auth/logout

Logout user (invalidate token on server if using token blacklist).

**Auth Required:** Yes

**Success Response (200):**
```typescript
{
  success: true;
  message: "Logged out successfully";
}
```

---

## 2. User Endpoints

### GET /api/users/me

Get current user profile.

**Auth Required:** Yes

**Success Response (200):**
```typescript
{
  user: User;
}
```

---

### PUT /api/users/me

Update current user profile.

**Auth Required:** Yes

**Request Body:**
```typescript
{
  fullName?: string;    // 2-100 characters
  phone?: string;       // E.164 format
  avatarUrl?: string;   // Valid URL
}
```

**Success Response (200):**
```typescript
{
  success: true;
  user: User;
}
```

---

### GET /api/users/me/roles

Get current user's roles.

**Auth Required:** Yes

**Success Response (200):**
```typescript
{
  roles: { role: 'super_admin' | 'salon_admin' | 'salon_staff' | 'user' }[];
}
```

---

### GET /api/users/me/memberships

Get current user's salon memberships.

**Auth Required:** Yes

**Success Response (200):**
```typescript
{
  memberships: {
    salonId: string;
    role: 'salon_admin' | 'salon_staff';
    salonName?: string;
  }[];
}
```

---

### GET /api/users

List users (admin or salon staff only).

**Auth Required:** Yes  
**Permissions:** `super_admin` OR `salon_staff` (with salonId filter)

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| salonId | string (UUID) | No* | Filter users with bookings at this salon |
| search | string | No | Search by name or phone |
| page | number | No | Page number (default: 1) |
| limit | number | No | Items per page (default: 20, max: 100) |

*Required for non-super_admin users

**Success Response (200):**
```typescript
{
  data: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

---

### PUT /api/users/:userId

Update another user's profile (admin only).

**Auth Required:** Yes  
**Permissions:** `super_admin`

**Request Body:** Same as PUT /api/users/me

---

### POST /api/users/roles

Add or remove user role.

**Auth Required:** Yes  
**Permissions:** `super_admin` OR `salon_admin` (for their salon's staff only)

**Request Body:**
```typescript
{
  userId: string;           // UUID
  role: 'super_admin' | 'salon_admin' | 'salon_staff' | 'user';
  action: 'add' | 'remove';
  salonId?: string;         // Required for salon_admin/salon_staff roles
}
```

**Success Response (200):**
```typescript
{
  success: true;
  message: string;
}
```

---

## 3. Salon Endpoints

### GET /api/salons

List salons with filters.

**Auth Required:** Optional (affects visibility)

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| status | string | No | Filter by status (super_admin only, others see only 'approved') |
| city | string | No | Filter by city (case-insensitive) |
| search | string | No | Search in name/description |
| page | number | No | Page number (default: 1) |
| limit | number | No | Items per page (default: 20, max: 100) |
| includeOwn | boolean | No | Include user's own pending salons |

**Success Response (200):**
```typescript
{
  data: Salon[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface Salon {
  id: string;
  name: string;
  description?: string;
  address: string;
  city: string;
  phone?: string;        // Only visible if authorized
  email?: string;        // Only visible if authorized
  imageUrl?: string;
  operatingHours: OperatingHours;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface OperatingHours {
  [day: string]: {      // monday, tuesday, etc.
    open: string;       // HH:mm format
    close: string;
    closed: boolean;
  };
}
```

**Contact Info Visibility Rules:**
- User is salon staff/admin
- User has active booking with salon
- User is super_admin

---

### GET /api/salons/:salonId

Get single salon details.

**Auth Required:** Optional

**Success Response (200):**
```typescript
{
  salon: Salon;
}
```

**Error Responses:**
- `404` - Salon not found or not approved (for unauthorized users)

---

### POST /api/salons

Create a new salon.

**Auth Required:** Yes

**Request Body:**
```typescript
{
  name: string;              // 2-100 characters
  description?: string;      // Max 1000 characters
  address: string;           // 5-200 characters
  city: string;              // 2-100 characters
  phone?: string;            // Valid phone format
  email?: string;            // Valid email format
  operatingHours?: OperatingHours;
}
```

**Default Operating Hours (if not provided):**
```typescript
{
  monday: { open: '09:00', close: '18:00', closed: false },
  tuesday: { open: '09:00', close: '18:00', closed: false },
  wednesday: { open: '09:00', close: '18:00', closed: false },
  thursday: { open: '09:00', close: '18:00', closed: false },
  friday: { open: '09:00', close: '18:00', closed: false },
  saturday: { open: '10:00', close: '16:00', closed: false },
  sunday: { open: '10:00', close: '16:00', closed: true }
}
```

**Success Response (201):**
```typescript
{
  success: true;
  message: "Salon created successfully";
  salon: Salon;
}
```

**Notes:**
- New salons are created with status `pending`
- Creator is automatically assigned `salon_admin` role for this salon

---

### PUT /api/salons/:salonId

Update salon details.

**Auth Required:** Yes  
**Permissions:** `salon_admin` of this salon OR `super_admin`

**Request Body:**
```typescript
{
  name?: string;
  description?: string;
  address?: string;
  city?: string;
  phone?: string;
  email?: string;
  operatingHours?: OperatingHours;
}
```

**Success Response (200):**
```typescript
{
  success: true;
  message: "Salon updated successfully";
  salon: Salon;
}
```

---

### POST /api/salons/:salonId/approve

Approve, reject, or suspend a salon.

**Auth Required:** Yes  
**Permissions:** `super_admin` only

**Request Body:**
```typescript
{
  action: 'approve' | 'reject' | 'suspend';
  reason?: string;           // Max 500 characters
}
```

**Success Response (200):**
```typescript
{
  success: true;
  message: string;           // e.g., "Salon approved successfully"
  salon: Salon;
}
```

---

### GET /api/salons/:salonId/services

Get services for a salon.

**Auth Required:** No (for approved salons)

**Success Response (200):**
```typescript
{
  services: Service[];
}

interface Service {
  id: string;
  salonId: string;
  name: string;
  description?: string;
  price: number;             // Decimal
  durationMinutes: number;   // e.g., 45
  maxCapacity: number;       // Default 3
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

---

### POST /api/salons/:salonId/services

Create a service.

**Auth Required:** Yes  
**Permissions:** `salon_admin` of this salon

**Request Body:**
```typescript
{
  name: string;
  description?: string;
  price: number;
  durationMinutes: number;
  maxCapacity?: number;      // Default 3
}
```

---

### PUT /api/salons/:salonId/services/:serviceId

Update a service.

**Auth Required:** Yes  
**Permissions:** `salon_admin` of this salon

---

### DELETE /api/salons/:salonId/services/:serviceId

Delete a service (or set isActive: false).

**Auth Required:** Yes  
**Permissions:** `salon_admin` of this salon

---

### GET /api/salons/:salonId/slots

Get available slots for a date.

**Auth Required:** No (for approved salons)

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| date | string | Yes | Date in YYYY-MM-DD format |

**Success Response (200):**
```typescript
{
  slots: Slot[];
}

interface Slot {
  id: string;
  salonId: string;
  date: string;           // YYYY-MM-DD
  startTime: string;      // HH:mm
  endTime: string;
  capacity: number;
  bookedCount: number;
  available: number;      // capacity - bookedCount
}
```

---

### POST /api/salons/:salonId/slots

Create slots for a date range.

**Auth Required:** Yes  
**Permissions:** `salon_admin` of this salon

**Request Body:**
```typescript
{
  dateFrom: string;         // YYYY-MM-DD
  dateTo: string;
  slotDuration: number;     // Minutes (default 30)
  capacity?: number;        // Default 3
}
```

---

## 4. Booking Endpoints

### GET /api/bookings

List bookings.

**Auth Required:** Yes

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| salonId | string | No | Filter by salon (required for staff) |
| status | string | No | 'booked', 'completed', 'cancelled', 'no_show', 'all' |
| dateFrom | string | No | Start date (YYYY-MM-DD) |
| dateTo | string | No | End date (YYYY-MM-DD) |
| page | number | No | Page number |
| limit | number | No | Items per page |

**Visibility Rules:**
- Regular users: Only their own bookings
- Salon staff: Bookings for their salon(s)
- Super admin: All bookings

**Success Response (200):**
```typescript
{
  data: Booking[];
  pagination: { ... };
}

interface Booking {
  id: string;
  userId: string;
  salonId: string;
  serviceId: string;
  slotId: string;
  bookingDate: string;      // YYYY-MM-DD
  startTime: string;        // HH:mm
  endTime: string;
  status: 'booked' | 'completed' | 'cancelled' | 'no_show';
  qrCode?: string;          // Unique code for check-in
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Joined data
  salon?: { id: string; name: string };
  service?: { id: string; name: string; price: number };
  user?: { id: string; fullName: string; phone: string };
}
```

---

### POST /api/bookings

Create a new booking.

**Auth Required:** Yes

**Request Body:**
```typescript
{
  salonId: string;          // UUID
  serviceId: string;
  slotId: string;
  bookingDate: string;      // YYYY-MM-DD
  startTime: string;        // HH:mm
  notes?: string;           // Max 500 characters
}
```

**Validation Rules:**
1. Salon must be approved
2. Slot must have available capacity
3. Service must be active
4. User cannot have duplicate booking for same slot
5. Booking date must be in the future

**Success Response (201):**
```typescript
{
  success: true;
  message: "Booking created successfully";
  booking: Booking;
}
```

**Notes:**
- `endTime` is calculated from `startTime` + service duration
- `qrCode` is auto-generated (format: `{random_hex}-{booking_id}`)

---

### GET /api/bookings/:bookingId

Get single booking details.

**Auth Required:** Yes  
**Permissions:** Owner, salon staff, or super_admin

---

### POST /api/bookings/:bookingId/cancel

Cancel a booking.

**Auth Required:** Yes  
**Permissions:** Owner, salon staff, or super_admin

**Request Body:**
```typescript
{
  reason?: string;          // Max 500 characters
}
```

**Validation Rules:**
- Only `booked` status bookings can be cancelled
- Updates slot `bookedCount` (decrements by 1)

**Success Response (200):**
```typescript
{
  success: true;
  message: "Booking cancelled successfully";
  booking: Booking;
}
```

---

### POST /api/bookings/:bookingId/complete

Complete a booking (check-in).

**Auth Required:** Yes  
**Permissions:** Salon staff of the booking's salon OR super_admin

**Request Body:**
```typescript
{
  qrCode?: string;          // Alternative: complete by QR code scan
  markNoShow?: boolean;     // Mark as no-show instead of completed
}
```

**Success Response (200):**
```typescript
{
  success: true;
  message: "Booking completed successfully" | "Booking marked as no-show";
  booking: Booking;
}
```

---

### GET /api/bookings/qr/:qrCode

Get booking by QR code (for scanning).

**Auth Required:** Yes  
**Permissions:** Salon staff or super_admin

**Success Response (200):**
```typescript
{
  booking: Booking;
}
```

---

## 5. Database Schema Reference

### Users Table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) UNIQUE NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### User Roles Table
```sql
CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('super_admin', 'salon_admin', 'salon_staff', 'user')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, role)
);
```

### Salon Memberships Table
```sql
CREATE TABLE salon_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  salon_id UUID REFERENCES salons(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('salon_admin', 'salon_staff')),
  invited_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, salon_id)
);
```

### Salons Table
```sql
CREATE TABLE salons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  address VARCHAR(200) NOT NULL,
  city VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  image_url TEXT,
  operating_hours JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  created_by UUID REFERENCES users(id) NOT NULL,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Services Table
```sql
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID REFERENCES salons(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  max_capacity INTEGER NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Slots Table
```sql
CREATE TABLE slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID REFERENCES salons(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 3,
  booked_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(salon_id, date, start_time)
);
```

### Bookings Table
```sql
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  salon_id UUID REFERENCES salons(id) NOT NULL,
  service_id UUID REFERENCES services(id) NOT NULL,
  slot_id UUID REFERENCES slots(id) NOT NULL,
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show')),
  qr_code TEXT UNIQUE,
  notes TEXT,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  completed_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### OTP Sessions Table (for authentication)
```sql
CREATE TABLE otp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL,
  otp_hash TEXT NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  used BOOLEAN NOT NULL DEFAULT false,
  ip_address TEXT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Rate Limits Table
```sql
CREATE TABLE rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier VARCHAR(255) NOT NULL,  -- 'phone:+1234567890' or 'ip:192.168.1.1'
  action VARCHAR(50) NOT NULL,       -- 'send_otp'
  count INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(identifier, action)
);
```

---

## 6. Middleware Requirements

### Authentication Middleware
```typescript
// Verify JWT and attach user to request
app.use('/api/*', authMiddleware);

interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    phone: string;
    roles: string[];
    salonMemberships: { salonId: string; role: string }[];
  };
}
```

### Role-Based Authorization
```typescript
// Helper functions
function isSuperAdmin(req: AuthenticatedRequest): boolean;
function isSalonAdmin(req: AuthenticatedRequest, salonId: string): boolean;
function isSalonStaff(req: AuthenticatedRequest, salonId: string): boolean;
```

### Rate Limiting
```typescript
// Apply to auth endpoints
const otpRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // per phone
  keyGenerator: (req) => req.body.phone,
});
```

---

## 7. Environment Variables

```env
# Server
PORT=5000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/tidytime

# JWT
JWT_SECRET=your-super-secret-jwt-key
JWT_EXPIRES_IN=7d

# Twilio (for OTP)
TWILIO_ACCOUNT_SID=your-account-sid
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_PHONE_NUMBER=+1234567890

# Rate Limiting
RATE_LIMIT_OTP_PER_PHONE=20
RATE_LIMIT_OTP_PER_IP=50

# CORS
CORS_ORIGIN=http://localhost:5173
```

---

## 8. Quick Start

```bash
# Install dependencies
npm install express cors helmet jsonwebtoken bcrypt pg zod twilio

# Run migrations
npm run migrate

# Start development server
npm run dev
```

**Recommended packages:**
- `express` - Web framework
- `cors` - CORS middleware
- `helmet` - Security headers
- `jsonwebtoken` - JWT handling
- `bcrypt` - Password/OTP hashing
- `pg` or `prisma` - PostgreSQL client
- `zod` - Request validation
- `twilio` - SMS OTP delivery
- `express-rate-limit` - Rate limiting
