const { ExampleCrawler } = require("./example");
const { KpisStdCodeCrawler } = require("./kpisStdCode");
const { VendorSalesImportCrawler } = require("./vendorSalesImport");

const CRAWLERS = {
  example: ExampleCrawler,
  "kpis-std-code": KpisStdCodeCrawler,
  "vendor-sales-import": VendorSalesImportCrawler,
};

module.exports = { CRAWLERS };
