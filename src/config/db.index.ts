import mongoose from "mongoose";
import { env } from "process";

export const connectDB = async () => {
  try {
    const uri = env.MONGO_URI as string;
    console.log(uri)
    if (!uri) {
      throw new Error("MONGO_URI not set in env");
    }
    await mongoose.connect(uri);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
};