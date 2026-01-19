import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import mqtt from "mqtt";
import mongoose from "mongoose";
import cors from "cors";
import { z } from "zod";
import "dotenv/config";

/* ======================================================
   1. ENV CONFIG
====================================================== */
const env = {
  MQTT_URL: process.env.MQTT_URL,
  MQTT_USER: process.env.MQTT_USERNAME,
  MQTT_PASS: process.env.MQTT_PASSWORD,
  MONGO_URI: process.env.MONGO_URI,
  FRONTEND_URL: process.env.FRONTEND_URL,
  PORT: process.env.PORT || 5000,
};

if (!env.MONGO_URI || !env.MQTT_URL || !env.FRONTEND_URL) {
  console.error("❌ Missing environment variables");
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
   2. TELEMETRY VALIDATION
====================================================== */
const boolish = z.union([
  z.boolean(),
  z.number().transform((v) => v === 1),
  z.string().transform((v) => v === "1" || v === "true"),
]);

const TelemetrySchema = z.object({
  s_raw: z.number(),
  s_pct: z.number(),
  s_temp: z.number().optional().default(0),
  a_temp: z.number().optional().default(0),
  hum: z.number(),
  pump: boolish,
  man: boolish,
  life: z.number(),
});

/* ======================================================
   3. DATABASE
====================================================== */
mongoose
  .connect(env.MONGO_URI)
  .then(() => console.log("🗄️ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB error:", err);
    process.exit(1);
  });

const TelemetrySchemaMongo = new mongoose.Schema(
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
    expireAfterSeconds: 60 * 60 * 24 * 60,
  },
);

TelemetrySchemaMongo.index({ timestamp: -1 });

const TelemetryModel = mongoose.model("Telemetry", TelemetrySchemaMongo);

/* ======================================================
   4. STATE
====================================================== */
let lastKnownState = null;
let lastMqttAt = null;
const pumpTimers = new Map();

/* ======================================================
   5. MQTT CLIENT
====================================================== */
const mqttClient = mqtt.connect(env.MQTT_URL, {
  username: env.MQTT_USER,
  password: env.MQTT_PASS,
  clientId: `backend_${Math.random().toString(16).slice(2)}`,
});

mqttClient.on("connect", () => {
  console.log("✅ Connected to HiveMQ");
  mqttClient.subscribe(CONSTANTS.TOPICS.DATA, { qos: 1 });
});

mqttClient.on("reconnect", () => {
  console.log("🔁 Reconnecting to HiveMQ...");
});

mqttClient.on("message", async (topic, message) => {
  if (topic !== CONSTANTS.TOPICS.DATA) return;

  try {
    const raw = JSON.parse(message.toString());
    const v = TelemetrySchema.parse(raw);

    const clean = {
      soil_raw: v.s_raw,
      soil_pct: v.s_pct,
      soil_temp: v.s_temp,
      air_temp: v.a_temp,
      humidity: v.hum,
      pump_on: !!v.pump,
      manual: !!v.man,
      pump_life: v.life,
      timestamp: new Date(),
    };

    lastKnownState = clean;
    lastMqttAt = Date.now();

    console.log("📡 TELEMETRY", clean);

    io.emit("telemetry:update", clean);

    await TelemetryModel.create({
      metadata: { nodeId: CONSTANTS.NODE_ID },
      ...clean,
    });
  } catch (err) {
    console.warn("⚠️ Invalid MQTT payload ignored:", err.message);
  }
});

/* ======================================================
   6. SERVER + SOCKET.IO
====================================================== */
const app = express();

const ALLOWED_ORIGINS = [
  "https://agrifarm-rw8z.onrender.com",
  "https://farm-dv9a.onrender.com",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  }),
);

app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
  transports: ["polling", "websocket"],
});

// io.on("connection", (socket) => {
//   console.log("🔌 UI connected:", socket.id);

//   if (lastKnownState) {
//     socket.emit("telemetry:init", lastKnownState);
//   }
// });

/* ======================================================
   7. API ROUTES
====================================================== */
app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    mqtt: mqttClient.connected,
    mongo: mongoose.connection.readyState === 1,
    lastMqttAt,
    uptime: process.uptime(),
  });
});

app.get("/api/history", async (_, res) => {
  const data = await TelemetryModel.find()
    .sort({ timestamp: -1 })
    .limit(100)
    .lean();

  res.json(data.reverse());
});

app.get("/api/trends", async (_, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const data = await TelemetryModel.find({
    timestamp: { $gte: dayAgo },
  })
    .sort({ timestamp: 1 })
    .lean();

  res.json(data);
});

app.get("/api/charts/24h", async (_, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const data = await TelemetryModel.aggregate([
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$timestamp",
              unit: "minute",
              binSize: 5,
            },
          },
          soil_pct: { $avg: "$soil_pct" },
          soil_temp: { $avg: "$soil_temp" },
          air_temp: { $avg: "$air_temp" },
          humidity: { $avg: "$humidity" },
          pump_on: { $max: "$pump_on" },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          timestamp: "$_id",
          soil_pct: { $round: ["$soil_pct", 1] },
          soil_temp: { $round: ["$soil_temp", 1] },
          air_temp: { $round: ["$air_temp", 1] },
          humidity: { $round: ["$humidity", 1] },
          pump_on: 1,
        },
      },
    ]);

    res.json(data);
  } catch (err) {
    console.error("❌ Aggregation error:", err);
    res.status(500).json({ error: "Aggregation failed" });
  }
});

app.post("/api/pump", (req, res) => {
  const { action, duration } = req.body;

  const cmd =
    action === "ON"
      ? "PUMP_ON"
      : action === "OFF"
        ? "PUMP_OFF"
        : action === "AUTO"
          ? "AUTO"
          : null;

  if (!cmd) return res.status(400).json({ error: "Invalid action" });

  mqttClient.publish(CONSTANTS.TOPICS.CMD, cmd, { qos: 1 });

  if (action === "ON" && duration) {
    if (pumpTimers.has(CONSTANTS.NODE_ID)) {
      clearTimeout(pumpTimers.get(CONSTANTS.NODE_ID));
    }

    const t = setTimeout(
      () => {
        mqttClient.publish(CONSTANTS.TOPICS.CMD, "PUMP_OFF");
        pumpTimers.delete(CONSTANTS.NODE_ID);
      },
      Math.min(duration, 3600) * 1000,
    );

    pumpTimers.set(CONSTANTS.NODE_ID, t);
  }

  res.json({ success: true, command: cmd });
});

/* ======================================================
   8. START SERVER
====================================================== */
httpServer.listen(env.PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${env.PORT}`);
});
