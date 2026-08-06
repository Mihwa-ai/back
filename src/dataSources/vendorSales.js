const { readTabularFile } = require("./readTabularFile");

// 실제 전달 파일의 헤더명이 확정되면 이 목록만 맞추면 된다.
// 화이트리스트에 없는 컬럼은 읽는 즉시 버려서, 개인정보 등 불필요한 컬럼이
// 엑셀/CSV에 같이 딸려와도 이후 로직에 노출되지 않도록 한다.
const SALES_COLUMNS = ["VEN_CD", "VEN_NM", "IO_GU", "PRODUCT_CD", "PRODUCT_NM", "REAL_OUT_AMT", "OQTY"];
const VENDOR_COLUMNS = ["VEN_CD", "VEN_NM", "sido", "sigungu", "subject"];
const PRODUCT_COLUMNS = ["Physic_Cd", "Physic_Nm", "Physic_Standard_Cd", "Physic_Group_Nm"];

function trimIfString(value) {
  return typeof value === "string" ? value.trim() : value;
}

function pickColumns(row, columns) {
  const picked = {};
  for (const col of columns) {
    picked[col] = trimIfString(row[col] ?? null);
  }
  return picked;
}

// 매출 원본 파일(엑셀/CSV/JSON) → 필요한 컬럼만 추출한 행 배열
// 나중에 MSSQL 접속이 복구되면 이 함수 내부만 IF_REVENUE_VIEW 조회로 바꿔치기하면 된다.
async function fetchSalesRowsFromFile(filePath) {
  const rows = await readTabularFile(filePath);
  return rows.map((row) => pickColumns(row, SALES_COLUMNS));
}

// 거래처 마스터 원본 파일 → 필요한 컬럼만 추출한 행 배열
async function fetchVendorMasterRowsFromFile(filePath) {
  const rows = await readTabularFile(filePath);
  return rows.map((row) => pickColumns(row, VENDOR_COLUMNS));
}

// 상품 마스터 원본 파일 → 필요한 컬럼만 추출한 행 배열
async function fetchProductMasterRowsFromFile(filePath) {
  const rows = await readTabularFile(filePath);
  return rows.map((row) => pickColumns(row, PRODUCT_COLUMNS));
}

module.exports = {
  SALES_COLUMNS,
  VENDOR_COLUMNS,
  PRODUCT_COLUMNS,
  fetchSalesRowsFromFile,
  fetchVendorMasterRowsFromFile,
  fetchProductMasterRowsFromFile,
};
