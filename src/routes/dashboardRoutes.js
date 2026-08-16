const express = require("express");
const multer = require("multer");
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
  getCampaigns,
  createCampaign,
  deleteCampaign,
  getPartnerHistory,
  addPartnerHistoryEntry,
  updatePartnerHistoryEntry,
  deletePartnerHistoryEntry,
  addPartnerHistoryAttachment,
  deletePartnerHistoryAttachment,
  getPartnerReportDownloads,
  logPartnerReportDownloadFile,
} = require("../services/dashboardQueries");
const { getDashboardAiSummary, getAiInsightTab, getBuyerAnalysisAiSummary } = require("../services/aiInsights");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

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
  "/ai-insight-tab",
  handle((req) => getAiInsightTab({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/buyer-analysis-summary",
  handle((req) => getBuyerAnalysisAiSummary({ ...commonFilters(req), month: req.query.month }))
);

router.get(
  "/campaigns",
  handle((req) => getCampaigns(commonFilters(req)))
);

router.post(
  "/campaigns",
  handle((req) => createCampaign(commonFilters(req), req.body))
);

router.delete(
  "/campaigns/:id",
  handle((req) => deleteCampaign(commonFilters(req), req.params.id))
);

router.get(
  "/partner-history",
  handle((req) =>
    getPartnerHistory({
      ...commonFilters(req),
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    })
  )
);

router.post(
  "/partner-history",
  handle((req) => addPartnerHistoryEntry(commonFilters(req), req.body))
);

router.put(
  "/partner-history/:id",
  handle((req) => updatePartnerHistoryEntry(commonFilters(req), req.params.id, req.body))
);

router.delete(
  "/partner-history/:id",
  handle((req) => deletePartnerHistoryEntry(commonFilters(req), req.params.id))
);

router.post(
  "/partner-history/:id/attachments",
  upload.single("file"),
  handle((req) => addPartnerHistoryAttachment(commonFilters(req), req.params.id, req.file))
);

router.delete(
  "/partner-history/attachments/:id",
  handle((req) => deletePartnerHistoryAttachment(commonFilters(req), req.params.id))
);

router.get(
  "/partner-report-downloads",
  handle((req) => getPartnerReportDownloads(commonFilters(req)))
);

router.post(
  "/partner-report-downloads/file",
  upload.single("file"),
  handle((req) => logPartnerReportDownloadFile(commonFilters(req), req.body, req.file))
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
