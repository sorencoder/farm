import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import mqtt from "mqtt";
import mongoose from "mongoose";
import cors from "cors";
import { z } from "zod";
import "dotenv/config";

/* ======================================================
   1. CONFIGURATION & ENV VALIDATION
====================================================== */
const env = {
  MQTT_URL:
    process.env.MQTT_URL ||
    "wss://aec7330a6b4a431a938a32666cbc9c16.s1.eu.hivemq.cloud:8884/mqtt",
  MQTT_USER: process.env.MQTT_USERNAME,
  MQTT_PASS: process.env.MQTT_PASSWORD,
  MONGO_URI: process.env.MONGO_URI,
  FRONTEND_URL: process.env.FRONTEND_URL,
  PORT: process.env.PORT || 5000,
};

// Simple check for required env
if (!env.MONGO_URI || !env.MQTT_USER || !env.FRONTEND_URL) {
  console.error(
    "❌ Missing vital environment variables. Check your .env file.",
  );
  process.exit(1);
}

const CONSTANTS = {
  NODE_ID: "node1",
  TOPICS: {
    DATA: "farm/node1/data",
    CMD: "farm/node1/cmd",
  },
};

/* ======================================================
   2. DATA VALIDATION (ZOD)
   Ensures bad sensor data doesn't crash the server or corrupt DB
====================================================== */
const TelemetrySchema = z.object({
  s_raw: z.number().min(0).max(1024),
  s_pct: z.number().min(0).max(100),
  s_temp: z.number().catch(0), // If temp sensor fails, default to 0
  a_temp: z.number().catch(0),
  hum: z.number().min(0).max(100),
  pump: z.boolean().or(z.number()),
  man: z.boolean().or(z.number()),
  life: z.number().nonnegative(),
});

/* ======================================================
   3. MONGODB SETUP (TimeSeries Optimized)
====================================================== */
mongoose
  .connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000, // Don't hang forever if DB is down
    socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  })
  .then(() => console.log("🗄️ Database Connected"))
  .catch((err) => {
    console.error("❌ Initial DB connection error:", err);
    process.exit(1); // Force Render to restart the app
  });

const TelemetryModel = mongoose.model(
  "Telemetry",
  new mongoose.Schema(
    {
      metadata: { nodeId: String },
      timestamp: Date,
      soil_raw: Number,
      soil_pct: Number,
      soil_temp: Number,
      air_temp: Number,
      humidity: Number,
      pump_on: Boolean,
      manual: Boolean,
      pump_life: Number,
    },
    {
      timeseries: {
        timeField: "timestamp",
        metaField: "metadata",
        granularity: "minutes",
      },
      expireAfterSeconds: 60 * 60 * 24 * 60, // 60 Days retention
    },
  ),
);

/* ======================================================
   4. STATE MANAGEMENT
====================================================== */
const pumpTimers = new Map(); // Stores active auto-off timeouts
let lastKnownState = null; // Cache for immediate frontend updates

/* ======================================================
   5. MQTT CLIENT
====================================================== */
const mqttClient = mqtt.connect(env.MQTT_URL, {
  username: env.MQTT_USER,
  password: env.MQTT_PASS,
  clientId: `backend_${Math.random().toString(16).substring(2, 8)}`,
});

mqttClient.on("connect", () => {
  console.log("✅ Connected to HiveMQ");
  // mqttClient.publish(CONSTANTS.TOPICS.DATA, "", { retain: true });
  mqttClient.subscribe(CONSTANTS.TOPICS.DATA);
});

mqttClient.on("message", async (topic, message) => {
  try {
    const rawData = JSON.parse(message.toString());
    // console.log(rawData);

    // Validate and Sanitize
    const validated = TelemetrySchema.parse(rawData);
    // console.log(validated);

    const cleanData = {
      nodeId: CONSTANTS.NODE_ID,
      soil_raw: validated.s_raw,
      soil_pct: validated.s_pct,
      soil_temp: validated.s_temp,
      air_temp: validated.a_temp,
      humidity: validated.hum,
      pump_on: !!validated.pump,
      manual: !!validated.man,
      pump_life: validated.life,
      timestamp: new Date(),
    };

    // Update Cache
    lastKnownState = cleanData;
    console.log(cleanData);
    // Broadcast to UI
    io.emit("farm_data_update", cleanData);

    // Persist to DB
    await TelemetryModel.create({
      metadata: { nodeId: cleanData.nodeId },
      timestamp: cleanData.timestamp,
      ...cleanData,
    });
  } catch (err) {
    console.warn("⚠️ Ignored invalid MQTT message:", err.message);
  }
});

/* ======================================================
   6. SERVER & SOCKETS
====================================================== */
const app = express();
app.use(cors({ origin: env.FRONTEND_URL }));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: env.FRONTEND_URL },
  transports: ["websocket"],
});

// Send cached data immediately when a user joins
io.on("connection", (socket) => {
  if (lastKnownState) {
    socket.emit("initial_data", lastKnownState);
  }
});

/* ======================================================
   7. API ENDPOINTS
====================================================== */
//HEALTH

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mqtt: mqttClient.connected,
    mongo: mongoose.connection.readyState === 1,
    uptime: process.uptime(),
  });
});

// History: Get raw data points
app.get(
  "/api/history",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);

    const data = await Telemetry.find({ "metadata.nodeId": CONSTANTS.NODE_ID })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean(); // .lean() skips hydrating Mongoose documents (Huge CPU saver)

    res.json(data.reverse());
  }),
);

// Get Graph Data (Last 24 Hours)
app.get("/api/trends", async (req, res) => {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const data = await TelemetryModel.find({
      timestamp: { $gte: dayAgo },
    })
      .sort({ timestamp: 1 })
      .lean();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Control the Pump
app.post("/api/pump", (req, res) => {
  const { action, duration } = req.body; // duration in seconds

  let mqttPayload = "";
  if (action === "ON") mqttPayload = "PUMP_ON";
  else if (action === "OFF") mqttPayload = "PUMP_OFF";
  else if (action === "AUTO") mqttPayload = "AUTO";
  else return res.status(400).json({ error: "Invalid action" });

  mqttClient.publish(CONSTANTS.TOPICS.CMD, mqttPayload, { qos: 1 });

  // Handle Auto-Off Timer
  if (action === "ON" && duration) {
    if (pumpTimers.has(CONSTANTS.NODE_ID))
      clearTimeout(pumpTimers.get(CONSTANTS.NODE_ID));

    const timer = setTimeout(
      () => {
        mqttClient.publish(CONSTANTS.TOPICS.CMD, "PUMP_OFF");
        pumpTimers.delete(CONSTANTS.NODE_ID);
      },
      Math.min(duration, 3600) * 1000,
    ); // Cap at 1 hour

    pumpTimers.set(CONSTANTS.NODE_ID, timer);
  }

  res.json({ success: true, command: mqttPayload });
});

/* ======================================================
   7. INITIALIZATION & SHUTDOWN
====================================================== */
httpServer.listen(env.PORT, "0.0.0.0", () => {
  console.log(`🚀 farm server running on port ${env.PORT}`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  // Application specific logging, then crash to let Render restart the instance
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

const gracefulShutdown = () => {
  console.log("\n🛑 Shutting down...");

  mqttClient.end();

  // Clear all timers
  pumpTimers.forEach((t) => clearTimeout(t));

  httpServer.close(() => {
    mongoose.connection.close(false).then(() => {
      console.log("👋 Cleanup complete.");
      process.exit(0);
    });
  });
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
