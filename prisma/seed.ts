import { AppRole, SalonStatus, SalonRole, PrismaClient } from '@prisma/client';
import slugify from 'slugify';

const prisma = new PrismaClient();

async function main() {
  console.log('--- 🏁 Starting MongoDB Seeding ---');

  // 1. Create Super Admin
   await prisma.user.upsert({
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