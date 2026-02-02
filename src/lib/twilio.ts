import twilio from 'twilio';


interface BookingConfirmationProps {
  phone: string;
  customerName: string;
  dateTime: Date | string;
  salonName?: string;
  adminPhone?: string;
}

// Initialize Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send OTP via Twilio SMS
 */
export async function sendOtp(phone: string, otp: string): Promise<void> {
  if (!process.env.TWILIO_PHONE_NUMBER) {
    throw new Error('TWILIO_PHONE_NUMBER not configured');
  }


  await client.messages.create({
    body: `Your Salons Vibes verification code is: ${otp}. Valid for 10 minutes.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
}

export async function sendBookingConfirmation({
  phone,
  customerName,
  dateTime,
  salonName = "Salons Vibes",
  adminPhone
}: BookingConfirmationProps): Promise<void> {
  // 1. Guard Clauses
  if (!process.env.TWILIO_PHONE_NUMBER) {
    throw new Error('TWILIO_PHONE_NUMBER not configured');
  }

  // 2. Professional Date Formatting (Native JS)
  // Result: "Mon, Feb 2 at 10:30 AM"
  const formattedDate = new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(dateTime)); // Ensure it's a Date object

  // 3. Dynamic Base URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.CORS_ORIGIN1 || 'https://salonsvibes.com' || 'https://salonshops.com';

  try {
    // 4. Send Message to CUSTOMER
    await client.messages.create({
      body: `Hi ${customerName}, your booking at ${salonName} is confirmed for ${formattedDate}. See you soon! Manage: ${baseUrl}/bookings`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });

    // 5. Send Message to SALON ADMIN
    if (adminPhone) {
      await client.messages.create({
        body: `NEW BOOKING: ${customerName} scheduled for ${formattedDate}. View details: ${baseUrl}/dashboard`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: adminPhone,
      });
    }
  } catch (error) {
    console.error('Twilio SMS Error:', error);
    // You might want to handle this silently or throw depending on your needs
  }
}

export default client;
