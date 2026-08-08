const express = require("express");
const {
  getKpiTrend,
  getSalesTypeTrend,
  getRegionSales,
  getDeptSales,
  getNewBuyers,
  getBuyerTrend,
  getBuyerSegments,
  getCompanies,
  getCompanyProducts,
} = require("../services/dashboardQueries");
const { getDashboardAiSummary } = require("../services/aiInsights");

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req);
      res.status(200).json(data);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] dashboard route error`, err);
      res.status(500).json({ error: err.message });
    }
  };
}

function commonFilters(req) {
  const { company, product, region, dept, channels } = req.query;
  return {
    company: company || undefined,
    product: product || undefined,
    region: region || undefined,
    dept: dept || undefined,
    channels: channels ? channels.split(",").filter(Boolean) : undefined,
  };
}

router.get(
  "/kpi-trend",
  handle((req) =>
    getKpiTrend({
      ...commonFilters(req),
      months: req.query.months ? Number(req.query.months) : undefined,
      endMonth: req.query.month,
    })
  )
);

router.get(
  "/sales-type-trend",
  handle((req) =>
    getSalesTypeTrend({
      ...commonFilters(req),
      months: req.query.months ? Number(req.query.months) : undefined,
      endMonth: req.query.month,
    })
  )
);

router.get(
  "/region-sales",
  handle((req) => getRegionSales({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/dept-sales",
  handle((req) => getDeptSales({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/new-buyers",
  handle((req) => getNewBuyers({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/buyer-trend",
  handle((req) => getBuyerTrend({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/buyer-segments",
  handle((req) => getBuyerSegments({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/ai-summary",
  handle((req) => getDashboardAiSummary({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/companies",
  handle(() => getCompanies())
);

router.get(
  "/companies/:groupNm/products",
  handle((req) => getCompanyProducts(req.params.groupNm))
);

module.exports = router;
