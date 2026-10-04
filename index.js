require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// base64 photos land in JSON bodies; /api/ootd/image sends several at once
app.use(express.json({ limit: "25mb" }));

// Routes
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

const wardrobeRoutes = require("./routes/wardrobe");
app.use("/api/wardrobe", wardrobeRoutes);

const ootdRoutes = require("./routes/ootd");
app.use("/api/ootd", ootdRoutes);

const userRoutes = require("./routes/user");
app.use("/api/user", userRoutes);

// Health check endpoints (for uptime checks / Render health checks)
app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "Kanti API Server is running" });
});

app.get("/healthz", (req, res) => {
  res.type("text").send("Server is healthy");
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ message: "Internal server error" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Kanti Server running on port ${PORT}`);
});
