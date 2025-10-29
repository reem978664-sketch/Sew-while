// status.js
// Simple status server for Fly.io verification and uptime monitoring

import express from "express";

const app = express();

// Main route – shows live system status
app.get("/", (req, res) => {
  res.send(`
    <div style="font-family:sans-serif;text-align:center;margin-top:100px;">
      <h1>🐋 SeaWhale Pro is running ✅</h1>
      <p>Environment: <b>${process.env.NODE_ENV || "production"}</b></p>
      <p>Fly.io Deployment Active</p>
      <p>Version: <b>${process.env.APP_VERSION || "latest"}</b></p>
    </div>
  `);
});

// optional health route for monitoring systems
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌊 SeaWhale status server is running on port ${PORT}`);
});
