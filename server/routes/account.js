const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/requireAuth");

router.get("/", requireAuth, (req, res) => {
  res.json({ stonkBalance: Number(req.account.stonk_balance.toFixed(2)) });
});

module.exports = router;
