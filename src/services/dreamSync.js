const { getSupabase } = require("../supabaseClient");

const CHUNK_SIZE = 500;

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.filter((v) => v !== null && v !== undefined && v !== "")));
}

// 코드 배열 → {코드: id} 맵. Supabase에서 단순 조회
async function fetchIdMap(codes, table, codeField) {
  if (!codes.length) return {};

  const supabase = getSupabase();
  const idMap = {};
  for (const codesChunk of chunk(codes, CHUNK_SIZE)) {
    const { data, error } = await supabase.from(table).select(`id,${codeField}`).in(codeField, codesChunk);
    if (error) throw error;
    for (const row of data) {
      idMap[row[codeField]] = row.id;
    }
  }
  return idMap;
}

// 거래처 코드 배열 → {ven_cd: id} 맵. 없는 코드는 vendorMasterRows에서 찾아 upsert 후 재조회
async function resolveVendorIdMap(venCds, vendorMasterRows) {
  if (!venCds.length) return {};

  const idMap = await fetchIdMap(venCds, "dream_vendor", "ven_cd");
  const missing = venCds.filter((cd) => !(cd in idMap));
  if (!missing.length) return idMap;

  const missingSet = new Set(missing);
  const rowsToUpsert = vendorMasterRows
    .filter((row) => row.VEN_CD && missingSet.has(row.VEN_CD))
    .map((row) => ({
      ven_cd: row.VEN_CD,
      ven_nm: row.VEN_NM,
      sido: row.sido || "",
      sigungu: row.sigungu || "",
      subject: row.subject || "",
      updated_at: new Date().toISOString(),
    }));

  if (rowsToUpsert.length) {
    const supabase = getSupabase();
    for (const rowsChunk of chunk(rowsToUpsert, CHUNK_SIZE)) {
      const { error } = await supabase.from("dream_vendor").upsert(rowsChunk, { onConflict: "ven_cd" });
      if (error) throw error;
    }
  }

  const refetched = await fetchIdMap(missing, "dream_vendor", "ven_cd");
  return { ...idMap, ...refetched };
}

// 상품 코드 배열 → {physic_cd: id} 맵. 없는 코드는 productMasterRows에서 찾아
// dream_partner의 physic_cd_filter로 파트너 대상만 걸러 upsert 후 재조회
async function resolveProductIdMap(physicCds, productMasterRows) {
  if (!physicCds.length) return {};

  const idMap = await fetchIdMap(physicCds, "dream_product", "physic_cd");
  const missing = physicCds.filter((cd) => !(cd in idMap));
  if (!missing.length) return idMap;

  const supabase = getSupabase();
  const { data: partners, error: partnerError } = await supabase
    .from("dream_partner")
    .select("id,group_nm,physic_cd_filter");
  if (partnerError) throw partnerError;

  const partnerIdByGroup = {};
  const partnerFilterByGroup = {};
  for (const p of partners || []) {
    partnerIdByGroup[p.group_nm] = p.id;
    partnerFilterByGroup[p.group_nm] = Array.isArray(p.physic_cd_filter) ? p.physic_cd_filter : [];
  }

  const missingSet = new Set(missing);
  const rowsToUpsert = [];
  for (const row of productMasterRows) {
    if (!row.Physic_Cd || !missingSet.has(row.Physic_Cd)) continue;
    const groupNm = row.Physic_Group_Nm;
    const partnerId = partnerIdByGroup[groupNm];
    if (partnerId === undefined) continue; // 파트너 미등록 그룹은 대상 아님

    const filter = partnerFilterByGroup[groupNm] || [];
    if (filter.length && !filter.includes(row.Physic_Cd)) continue; // 파트너 필터에서 제외된 코드

    rowsToUpsert.push({
      physic_cd: row.Physic_Cd,
      physic_nm: row.Physic_Nm,
      physic_std: row.Physic_Standard_Cd,
      partner_id: partnerId,
      updated_at: new Date().toISOString(),
    });
  }

  if (rowsToUpsert.length) {
    for (const rowsChunk of chunk(rowsToUpsert, CHUNK_SIZE)) {
      const { error } = await supabase.from("dream_product").upsert(rowsChunk, { onConflict: "physic_cd" });
      if (error) throw error;
    }
  }

  const refetched = await fetchIdMap(missing, "dream_product", "physic_cd");
  return { ...idMap, ...refetched };
}

function makeSaleBase(row, saleDate, saleType) {
  return {
    sale_date: saleDate,
    sale_type: saleType,
    ven_cd: row.VEN_CD,
    ven_nm: row.VEN_NM,
    product_cd: row.PRODUCT_CD,
    product_nm: row.PRODUCT_NM,
    price: row.price,
    qty: row.qty,
    status: "대기",
  };
}

function normalizeSalesRow(row) {
  return {
    VEN_CD: row.VEN_CD,
    VEN_NM: row.VEN_NM,
    IO_GU: row.IO_GU,
    PRODUCT_CD: row.PRODUCT_CD,
    PRODUCT_NM: row.PRODUCT_NM,
    price: Number(row.REAL_OUT_AMT) || 0,
    qty: parseInt(row.OQTY, 10) || 0,
  };
}

// 매출 원본 행 + 거래처/상품 마스터 행을 받아 매칭 후
// dream_vendor_sales / dream_failed_sales에 직접 적재 (staging 미사용, 동일 sale_date 재실행 시 덮어쓰기)
async function syncSales({ saleDate, salesRows, vendorMasterRows, productMasterRows }) {
  const rows = salesRows.map(normalizeSalesRow);

  const allProductCds = uniqueNonEmpty(rows.map((r) => r.PRODUCT_CD));
  const productIdMap = await resolveProductIdMap(allProductCds, productMasterRows);

  // 상품마스터엔 존재하지만 파트너 대상이 아니라 매칭 안 된 코드는 실패목록에서 제외
  const productMasterCds = new Set(productMasterRows.map((r) => r.Physic_Cd));
  const partnerNotMatched = new Set(allProductCds.filter((cd) => !(cd in productIdMap) && productMasterCds.has(cd)));

  const matchedRows = rows.filter((r) => r.PRODUCT_CD in productIdMap);
  const unmatchedRows = rows.filter((r) => !(r.PRODUCT_CD in productIdMap));

  const matchedVenCds = uniqueNonEmpty(matchedRows.map((r) => r.VEN_CD));
  const vendorIdMap = await resolveVendorIdMap(matchedVenCds, vendorMasterRows);

  const salesInsert = [];
  const failedInsert = [];

  for (const r of matchedRows) {
    const saleType = r.IO_GU === "매출" ? "매출" : "도매";
    const vendorId = vendorIdMap[r.VEN_CD];
    if (!vendorId) {
      failedInsert.push({ fail_reason: "vendor_not_found", ...makeSaleBase(r, saleDate, saleType) });
      continue;
    }
    salesInsert.push({
      sale_date: saleDate,
      sale_type: saleType,
      vendor_id: vendorId,
      product_id: productIdMap[r.PRODUCT_CD],
      price: r.price,
      qty: r.qty,
    });
  }

  for (const r of unmatchedRows) {
    if (partnerNotMatched.has(r.PRODUCT_CD)) continue;
    const saleType = r.IO_GU === "매출" ? "매출" : "도매";
    failedInsert.push({ fail_reason: "product_not_found", ...makeSaleBase(r, saleDate, saleType) });
  }

  const supabase = getSupabase();

  const { error: deleteSalesError } = await supabase.from("dream_vendor_sales").delete().eq("sale_date", saleDate);
  if (deleteSalesError) throw deleteSalesError;
  const { error: deleteFailedError } = await supabase.from("dream_failed_sales").delete().eq("sale_date", saleDate);
  if (deleteFailedError) throw deleteFailedError;

  for (const rowsChunk of chunk(salesInsert, CHUNK_SIZE)) {
    const { error } = await supabase.from("dream_vendor_sales").insert(rowsChunk);
    if (error) throw error;
  }
  for (const rowsChunk of chunk(failedInsert, CHUNK_SIZE)) {
    const { error } = await supabase.from("dream_failed_sales").insert(rowsChunk);
    if (error) throw error;
  }

  return { successCount: salesInsert.length, failCount: failedInsert.length };
}

module.exports = { resolveVendorIdMap, resolveProductIdMap, syncSales };
