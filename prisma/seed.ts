import { AppRole, SalonStatus, SalonRole, PrismaClient } from '@prisma/client';
import slugify from 'slugify';

const prisma = new PrismaClient();

async function main() {
  console.log('--- 🏁 Starting MongoDB Seeding ---');

  // 1. Create Super Admin
  const superAdmin = await prisma.user.upsert({
    where: { phone: '+61481452920' },
    update: {},
    create: {
      phone: '+61481452920',
      email: 'rabin9087@gmail.com',
      fullName: 'Rabin Shah',
      roles: {
        create: { role: AppRole.super_admin },
      },
    },
  });
  console.log('✅ Super Admin Created');

  // 2. Create Salon Admin User
  const salonAdminUser = await prisma.user.upsert({
    where: { phone: '+61416823979' },
    update: {},
    create: {
      phone: '+61416823979',
      email: 'desidudesalon@gmail.com',
      fullName: 'Desi Dude Admin',
      roles: {
        create: { role: AppRole.salon_admin },
      },
    },
  });
  console.log('✅ Salon Admin User Created');

  // 3. Create Salon
  const salonName = 'Desi Dude Kogarah';
  const salonSlug = slugify(salonName, { lower: true, strict: true });

  const salon = await prisma.salon.upsert({
    where: { slug: salonSlug },
    update: {},
    create: {
      name: salonName,
      slug: salonSlug,
      email: 'desidudesalon@gmail.com',
      address: '123 Railway Parade',
      city: 'Kogarah',
      phone: '+61416823979',
      status: SalonStatus.approved,
      createdBy: salonAdminUser.id,
      approvedBy: superAdmin.id,
      approvedAt: new Date(),
      operatingHours: {
        monday: { open: '09:00', close: '18:00' },
        tuesday: { open: '09:00', close: '18:00' },
        wednesday: { open: '09:00', close: '18:00' },
        thursday: { open: '09:00', close: '20:00' },
        friday: { open: '09:00', close: '20:00' },
        saturday: { open: '09:00', close: '17:00' },
        sunday: { open: 'Closed', close: 'Closed' }, // MongoDB prefers objects over booleans in mixed JSON
      },
      memberships: {
        create: {
          userId: salonAdminUser.id,
          role: SalonRole.salon_admin,
        },
      },
      services: {
        create: {
          name: 'Men\'s Haircut',
          price: 30.00,
          durationMinutes: 30,
        }
      }
    },
  });
  console.log('✅ Salon and Membership Created');

  // 4. Create Regular User
  const customer = await prisma.user.upsert({
    where: { phone: '+61452162920' },
    update: {},
    create: {
      phone: '+61452162920',
      email: 'poojasah1732@gmail.com',
      fullName: 'Pooja Kumari',
      roles: {
        create: { role: AppRole.user },
      },
    },
  });
  console.log('✅ Regular Customer Created');

  console.log('--- 🌱 Seeding Finished ---');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });