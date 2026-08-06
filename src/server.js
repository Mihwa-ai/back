const crypto = require("crypto");
const cors = require("cors");
const express = require("express");

const { PORT, CRAWL_TRIGGER_SECRET } = require("./config");
const { CRAWLERS } = require("./crawlers");
const dashboardRoutes = require("./routes/dashboardRoutes");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/dashboard", dashboardRoutes);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

function checkSecret(req, res, next) {
  const provided = req.get("x-crawl-secret") || "";
  const expected = CRAWL_TRIGGER_SECRET;

  const ok =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!ok) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/crawl/:job", checkSecret, async (req, res) => {
  const { job } = req.params;
  const CrawlerClass = CRAWLERS[job];
  if (!CrawlerClass) {
    return res.status(404).json({ error: `unknown job "${job}"` });
  }

  try {
    console.log(`[${new Date().toISOString()}] starting job=${job} params=${JSON.stringify(req.body)}`);
    const rows = await new CrawlerClass(req.body).run();
    console.log(`[${new Date().toISOString()}] finished job=${job}`);
    res.status(200).json({ job, status: "ok", data: rows });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] failed job=${job}`, err);
    res.status(500).json({ job, status: "error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`server listening on port ${PORT}`);
});
