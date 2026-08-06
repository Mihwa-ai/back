const { Crawler } = require("./base");
const {
  fetchSalesRowsFromFile,
  fetchVendorMasterRowsFromFile,
  fetchProductMasterRowsFromFile,
} = require("../dataSources/vendorSales");
const { syncSales } = require("../services/dreamSync");

function toIsoDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// 회사에서 받은 매출/거래처/상품 파일(엑셀·CSV·JSON)을 읽어
// 매칭 후 dream_vendor_sales/dream_failed_sales에 직접 적재.
// params: { salesFile, vendorFile, productFile, date(YYYYMMDD) }
class VendorSalesImportCrawler extends Crawler {
  async run() {
    const { salesFile, vendorFile, productFile, date } = this.params;
    if (!salesFile) throw new Error("salesFile param is required");
    if (!vendorFile) throw new Error("vendorFile param is required");
    if (!productFile) throw new Error("productFile param is required");
    if (!date || !/^\d{8}$/.test(date)) throw new Error("date param is required (format: YYYYMMDD)");

    const [salesRows, vendorMasterRows, productMasterRows] = await Promise.all([
      fetchSalesRowsFromFile(salesFile),
      fetchVendorMasterRowsFromFile(vendorFile),
      fetchProductMasterRowsFromFile(productFile),
    ]);

    return syncSales({
      saleDate: toIsoDate(date),
      salesRows,
      vendorMasterRows,
      productMasterRows,
    });
  }
}

module.exports = { VendorSalesImportCrawler };
