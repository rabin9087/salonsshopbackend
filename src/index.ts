import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { errorHandler } from './middleware/errorHandler.js';
import mongoSanitize from "express-mongo-sanitize";
import morgan from "morgan";
import router from './routes/router.index.js'

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;
// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://192.168.1.108:8080 || http://192.168.2.179:8080",
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
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`-----------------------------------------------`);
  console.log(`🚀 Backend Server running on:`);
  console.log(`🏠 Local:   http://localhost:${PORT}`);
  console.log(`🌐 Network: http://192.168.1.108:${PORT}`);
  console.log(`-----------------------------------------------`);
});

export default app;
