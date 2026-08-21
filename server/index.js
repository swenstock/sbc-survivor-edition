require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");

require("./db"); // creates users/accounts/ledger tables on first run
require("./knockoutSchema").run();

const path = require("path");
const authRoutes = require("./routes/auth");
const accountRoutes = require("./routes/account");
const knockoutRoutes = require("./routes/knockout");
const knockoutScheduler = require("./knockoutScheduler");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/knockout", knockoutRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true, project: "sbc-survivor-edition" }));
app.use(express.static(path.join(__dirname, "..", "public")));

knockoutScheduler.start();

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SBC Survivor Edition running on http://localhost:${PORT}`);
});
