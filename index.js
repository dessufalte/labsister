require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const admin = require("firebase-admin");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json());
app.use(cors());

// 🔐 Firebase setup dari ENV
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// WebSocket setup
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let wsClients = [];
let sseClients = [];
let latestData = {};

// Broadcast WebSocket
function broadcastWebSocket(data) {
  const payload = JSON.stringify(data);
  wsClients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Broadcast SSE
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => client.res.write(payload));
}

// MQTT setup
const mqttClient = mqtt.connect(process.env.MQTT_BROKER);

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected to", process.env.MQTT_BROKER);
  mqttClient.subscribe(process.env.MQTT_TOPIC, (err) => {
    if (err) console.error("❌ MQTT subscribe error:", err.message);
    else console.log("✅ Subscribed to topic:", process.env.MQTT_TOPIC);
  });
});

mqttClient.on("message", (topic, message) => {
  let data;
  try {
    data = JSON.parse(message.toString());
  } catch (err) {
    console.warn("⚠️  MQTT payload bukan JSON:", message.toString());
    return;
  }

  if (typeof data === "object") {
    const withTimestamp = { ...data, waktu: new Date().toISOString() };
    latestData = withTimestamp;
    db.collection("sensorData").add(withTimestamp);
    broadcastSSE(withTimestamp);
    broadcastWebSocket(withTimestamp);
    console.log("📥 MQTT message broadcasted:", withTimestamp);
  }
});

// WebSocket connection handler
wss.on("connection", (ws) => {
  console.log("🔌 WebSocket client connected");
  wsClients.push(ws);
  if (latestData) ws.send(JSON.stringify(latestData));
  ws.on("close", () => {
    wsClients = wsClients.filter((client) => client !== ws);
    console.log("❌ WebSocket client disconnected");
  });
});

// MQTT Status
app.get("/mqtt/status", (req, res) => {
  const connected = mqttClient.connected;
  res.status(connected ? 200 : 503).json({
    status: connected ? "connected" : "disconnected",
    broker: process.env.MQTT_BROKER,
    topic: process.env.MQTT_TOPIC,
  });
});

// Ambil semua data
app.get("/data", async (req, res) => {
  try {
    let query = db.collection("sensorData");
    if (req.query.since) {
      const sinceDate = new Date(req.query.since);
      if (!isNaN(sinceDate)) query = query.where("waktu", ">=", sinceDate.toISOString());
    }
    const order = req.query.order === "asc" ? "asc" : "desc";
    query = query.orderBy("waktu", order);
    if (req.query.limit) {
      const limit = parseInt(req.query.limit);
      if (!isNaN(limit)) query = query.limit(limit);
    }
    const snapshot = await query.get();
    const result = [];
    snapshot.forEach((doc) => result.push({ id: doc.id, ...doc.data() }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kirim data manual
app.post("/manual", async (req, res) => {
  const { jarak_cm, gerakan, mq2 } = req.body;
  if (jarak_cm == null || gerakan == null || mq2 == null)
    return res.status(400).json({ error: "Data tidak lengkap" });

  try {
    const withTimestamp = { jarak_cm, gerakan, mq2, waktu: new Date().toISOString() };
    latestData = withTimestamp;
    await db.collection("sensorData").add(withTimestamp);
    broadcastSSE(withTimestamp);
    broadcastWebSocket(withTimestamp);
    res.json({ status: "Tersimpan" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Data realtime
app.get("/realtime", (req, res) => {
  if (!latestData || Object.keys(latestData).length === 0)
    return res.status(204).json({ message: "Belum ada data" });
  res.json(latestData);
});

// SSE
app.get("/realtime/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  if (latestData) res.write(`data: ${JSON.stringify(latestData)}\n\n`);
  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);
  console.log(`➕ Client SSE terhubung: ${clientId} (total: ${sseClients.length})`);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
    console.log(`❌ Client SSE terputus: ${clientId} (total: ${sseClients.length})`);
  });
});

// Run
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 HTTP & WebSocket server running on http://localhost:${PORT}`);
});
