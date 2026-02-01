# Salon Vibes - Backend API

Express.js + Prisma backend for the Salon Vibes booking system.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Edit .env with your configuration

# Generate Prisma client
npm run db:generate

# Push schema to database (development)
npm run db:push

# Or run migrations (production)
npm run db:migrate

# Start development server
npm run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build for production |
| `npm start` | Start production server |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:push` | Push schema to database |
| `npm run db:migrate` | Run database migrations |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:seed` | Seed database with sample data |

## API Documentation

See `../docs/API_SPECIFICATION.md` for complete API documentation.

## Project Structure

```
backend/
├── prisma/
│   └── schema.prisma      # Database schema
├── src/
│   ├── index.ts           # Express app entry point
│   ├── routes/
│   │   ├── auth.ts        # Authentication endpoints
│   │   ├── users.ts       # User management
│   │   ├── salons.ts      # Salon CRUD + services/slots
│   │   └── bookings.ts    # Booking management
│   ├── middleware/
│   │   ├── auth.ts        # JWT authentication
│   │   ├── errorHandler.ts # Global error handling
│   │   └── rateLimit.ts   # Rate limiting
│   └── lib/
│       ├── prisma.ts      # Prisma client singleton
│       └── twilio.ts      # Twilio SMS client
├── .env.example           # Environment template
├── package.json
└── tsconfig.json
```

## Environment Variables

See `.env.example` for all required environment variables.

## Database

Uses PostgreSQL with Prisma ORM. Schema defined in `prisma/schema.prisma`.

## Authentication Flow

1. Client sends phone → `POST /api/auth/send-otp`
2. Server sends OTP via Twilio, returns session token
3. Client submits OTP → `POST /api/auth/verify-otp`
4. Server verifies OTP, returns JWT token
5. Client includes JWT in `Authorization: Bearer <token>` header

## Role-Based Access Control

| Role | Permissions |
|------|-------------|
| `user` | Create bookings, view own data |
| `salon_staff` | Manage salon bookings, complete check-ins |
| `salon_admin` | Full salon management, invite staff |
| `super_admin` | Full system access, approve salons |
# salonsshopbackend
