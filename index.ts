import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { errorHandler } from './src/middleware/errorHandler.js';
import mongoSanitize from "express-mongo-sanitize";
import morgan from "morgan";
import router from './src/routes/router.index.js'

// Load environment variables
dotenv.config();

const allowedOrigins = [
  'http://localhost:5173', // Vite default
  'http://localhost:8080', // Common port
  'http://localhost:3000', // Next.js default
  'http://192.168.1.10',   // CHANGE THIS to your actual local IP for mobile testing
  // Add your Lovable or production domain here
];

const app = express();
const PORT = process.env.PORT || 5001;
// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5001/' || 'http://localhost:8080/',
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
}));
app.use(morgan("short"));
// Parse JSON
app.use(express.json());
// Prevent MongoDB operator injection
app.use(mongoSanitize());
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allows images/resources across origins
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
}));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api', router);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Global error handler
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📚 API docs: See docs/API_SPECIFICATION.md`);
});

export default app;
