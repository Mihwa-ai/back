const { getSupabase } = require("../supabaseClient");
const { getOrSet } = require("./cache");

const MAX_MONTH = "2026-07"; // TODO: 임시 하드코딩 — 이후 최신 완결 월 기준으로 교체 필요

const VENDOR_TTL = 10 * 60 * 1000;
const CATALOG_TTL = 10 * 60 * 1000;
const SALES_TTL = 2 * 60 * 1000;
const FIRST_PURCHASE_TTL = 10 * 60 * 1000;
const PARTNER_ID_TTL = 10 * 60 * 1000;
const MART_TTL = 2 * 60 * 1000;

const SIDO_SHORT = {
  "서울특별시": "서울", "서울": "서울",
  "경기도": "경기", "경기": "경기",
  "부산광역시": "부산", "부산": "부산",
  "인천광역시": "인천", "인천": "인천",
  "대구광역시": "대구", "대구": "대구",
  "대전광역시": "대전", "대전": "대전",
  "광주광역시": "광주", "광주": "광주",
  "울산광역시": "울산", "울산": "울산",
  "세종특별자치시": "세종", "세종": "세종",
  "강원도": "강원", "강원특별자치도": "강원", "강원": "강원",
  "충청북도": "충북", "충북": "충북",
  "충청남도": "충남", "충남": "충남",
  "전라북도": "전북", "전북특별자치도": "전북", "전북": "전북",
  "전라남도": "전남", "전남": "전남",
  "경상북도": "경북", "경북": "경북",
  "경상남도": "경남", "경남": "경남",
  "제주특별자치도": "제주", "제주": "제주",
};
const SIDO_SHORT_VALUES = [...new Set(Object.values(SIDO_SHORT))];

function shortSido(raw) {
  if (!raw) return "미분류";
  if (SIDO_SHORT[raw]) return SIDO_SHORT[raw];
  for (const short of SIDO_SHORT_VALUES) {
    if (raw.startsWith(short)) return short;
  }
  return raw;
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

function shiftMonth(mk, offset) {
  const [y, m] = mk.split("-").map(Number);
  const total = y * 12 + (m - 1) + offset;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function monthDiff(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return ay * 12 + am - (by * 12 + bm);
}

function clampMonth(mk) {
  return mk > MAX_MONTH ? MAX_MONTH : mk;
}

function lastNMonthKeys(n, endMonthKey) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(shiftMonth(endMonthKey, -i));
  return keys;
}

async function fetchAllRows(table, columns) {
  const supabase = getSupabase();
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function getVendorLookup() {
  return getOrSet("vendorLookup", VENDOR_TTL, async () => {
    const rows = await fetchAllRows("dream_vendor", "ven_cd, ven_nm, sido, subject");
    const map = new Map();
    for (const r of rows) {
      map.set(r.ven_cd, { name: r.ven_nm || r.ven_cd, sido: shortSido(r.sido), subject: r.subject || "미분류" });
    }
    return map;
  });
}

function getProductCatalog() {
  return getOrSet("productCatalog", CATALOG_TTL, async () => {
    const [products, partners] = await Promise.all([
      fetchAllRows("dream_product", "physic_cd, physic_nm, physic_std, partner_id"),
      fetchAllRows("dream_partner", "id, group_nm"),
    ]);
    const partnerById = new Map(partners.map((p) => [p.id, p.group_nm]));
    return products.map((p) => ({ ...p, group_nm: partnerById.get(p.partner_id) || null }));
  });
}

async function resolveProductCdSet({ company, product } = {}) {
  if (!company && !product) return null; // null = no product filter
  const catalog = await getProductCatalog();
  let list = catalog;
  if (company) list = list.filter((p) => p.group_nm === company);
  if (product) list = list.filter((p) => p.physic_cd === product);
  return new Set(list.map((p) => p.physic_cd));
}

function fetchSalesRangeCached(rangeStart, rangeEnd, productCdSet) {
  const productCdsKey = productCdSet ? [...productCdSet].sort().join(",") : "all";
  return getOrSet(`sales:${rangeStart}:${rangeEnd}:${productCdsKey}`, SALES_TTL, async () => {
    const supabase = getSupabase();
    const pageSize = 1000;
    let from = 0;
    const rows = [];
    for (;;) {
      const { data, error } = await supabase
        .rpc("dashboard_sales_monthly_agg", {
          range_start: rangeStart,
          range_end: rangeEnd,
          product_cds: productCdSet ? [...productCdSet] : null,
        })
        .range(from, from + pageSize - 1);

      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return rows.map((r) => ({ ...r, sale_date: r.month }));
  });
}

function channelsToSaleTypes(channels) {
  if (!channels || !channels.length) return null;
  return channels.map((c) => (c === "병의원" ? "매출" : "도매"));
}

// kpi-trend는 넓은 기간(최대 23개월)을 훑기 때문에 거래처 단위로 행을 받으면
// (거래처 1만개 이상) 페이지네이션 왕복이 너무 많아진다. 월 단위로만 이미 합산된
// 결과(가격/수량 합계, 구매자수)를 SQL에서 바로 계산해 20여 행만 받는다.
// region/dept는 거래처 코드 배열로 넘기지 않고(수천 개짜리 배열은 planner가 느리게 처리해
// 8초 타임아웃이 났었음) dream_vendor와의 JOIN으로 SQL 함수 안에서 직접 필터링한다.
function fetchKpiMonthlyAgg(rangeStart, rangeEnd, { productCdSet, region, dept, saleTypes }) {
  const key = `kpiAgg:${rangeStart}:${rangeEnd}:${productCdSet ? [...productCdSet].sort().join(",") : "all"}:${
    region || "all"
  }:${dept || "all"}:${saleTypes ? saleTypes.slice().sort().join(",") : "all"}`;

  return getOrSet(key, SALES_TTL, async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("dashboard_kpi_trend_agg", {
      range_start: rangeStart,
      range_end: rangeEnd,
      product_cds: productCdSet ? [...productCdSet] : null,
      region: region || null,
      dept: dept || null,
      sale_types: saleTypes,
    });
    if (error) throw new Error(error.message);
    return data;
  });
}

// sales-type-trend도 kpi-trend와 같은 이유로 월×매출유형 단위로만 SQL에서 집계해서 받는다.
function fetchSalesTypeMonthlyAgg(rangeStart, rangeEnd, { productCdSet, region, dept }) {
  const key = `salesTypeAgg:${rangeStart}:${rangeEnd}:${productCdSet ? [...productCdSet].sort().join(",") : "all"}:${
    region || "all"
  }:${dept || "all"}`;

  return getOrSet(key, SALES_TTL, async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("dashboard_sales_type_trend_agg", {
      range_start: rangeStart,
      range_end: rangeEnd,
      product_cds: productCdSet ? [...productCdSet] : null,
      region: region || null,
      dept: dept || null,
    });
    if (error) throw new Error(error.message);
    return data;
  });
}

// productCdSet 필터는 fetchSalesRangeCached 단계(SQL WHERE)에서 이미 적용되므로 여기서는 다루지 않는다.
function buildRowFilter({ region, dept, channels, vendorLookup }) {
  const channelSet = channels && channels.length ? new Set(channels) : null;
  return (row) => {
    if (channelSet) {
      const bucket = row.sale_type === "매출" ? "병의원" : "도매";
      if (!channelSet.has(bucket)) return false;
    }
    if (region || dept) {
      const info = vendorLookup.get(row.ven_cd);
      if (region && (!info || info.sido !== region)) return false;
      if (dept && (!info || info.subject !== dept)) return false;
    }
    return true;
  };
}

async function getKpiTrend(filters = {}) {
  const { months = 12, endMonth } = filters;
  const end = clampMonth(endMonth || monthKey(new Date().toISOString().slice(0, 10)));
  const currMonths = lastNMonthKeys(months, end);
  const prevMonths = currMonths.map((m) => shiftMonth(m, -12));
  const rangeStart = `${prevMonths[0]}-01`;
  const rangeEnd = `${shiftMonth(end, 1)}-01`;

  const productCdSet = await resolveProductCdSet(filters);
  const saleTypes = channelsToSaleTypes(filters.channels);

  const agg = await fetchKpiMonthlyAgg(rangeStart, rangeEnd, { productCdSet, region: filters.region, dept: filters.dept, saleTypes });
  const byMonth = new Map(agg.map((r) => [monthKey(r.month), r]));

  const buildSeries = (monthList) =>
    monthList.map((mk) => {
      const bucket = byMonth.get(mk);
      return {
        sales: bucket ? Number(bucket.price) / 100000000 : 0,
        qty: bucket ? Number(bucket.qty) : 0,
        buyer: bucket ? Number(bucket.buyers) : 0,
      };
    });

  const curr = buildSeries(currMonths);
  const prev = buildSeries(prevMonths);

  return {
    months: currMonths,
    sales: { curr: curr.map((m) => m.sales), prev: prev.map((m) => m.sales) },
    qty: { curr: curr.map((m) => m.qty), prev: prev.map((m) => m.qty) },
    buyer: { curr: curr.map((m) => m.buyer), prev: prev.map((m) => m.buyer) },
  };
}

async function getSalesTypeTrend(filters = {}) {
  const { months = 4, endMonth } = filters;
  const end = clampMonth(endMonth || monthKey(new Date().toISOString().slice(0, 10)));
  const monthList = lastNMonthKeys(months, end);
  const rangeStart = `${monthList[0]}-01`;
  const rangeEnd = `${shiftMonth(end, 1)}-01`;

  const productCdSet = await resolveProductCdSet(filters);
  // channels 필터는 원래 buildRowFilter가 sale_type 버킷으로 걸렀던 것과 동일하게,
  // "채널이 하나만 선택된 경우" sale_types 배열로 그대로 넘긴다.
  const saleTypes = channelsToSaleTypes(filters.channels);

  const agg = await fetchSalesTypeMonthlyAgg(rangeStart, rangeEnd, { productCdSet, region: filters.region, dept: filters.dept });
  const filteredAgg = saleTypes ? agg.filter((r) => saleTypes.includes(r.sale_type)) : agg;
  const byMonth = new Map();
  for (const r of filteredAgg) {
    const mk = monthKey(r.month);
    if (!byMonth.has(mk)) byMonth.set(mk, { clinic: 0, wholesale: 0 });
    const bucket = byMonth.get(mk);
    if (r.sale_type === "매출") bucket.clinic += Number(r.price) || 0;
    else bucket.wholesale += Number(r.price) || 0;
  }

  return monthList.map((mk, i) => {
    const bucket = byMonth.get(mk) || { clinic: 0, wholesale: 0 };
    return {
      month: mk,
      clinic: bucket.clinic / 100000000,
      wholesale: bucket.wholesale / 100000000,
      current: i === monthList.length - 1,
    };
  });
}

async function getRegionSales(filters = {}) {
  const mk = clampMonth(filters.month || monthKey(new Date().toISOString().slice(0, 10)));
  const rangeStart = `${mk}-01`;
  const rangeEnd = `${shiftMonth(mk, 1)}-01`;

  const [vendorLookup, productCdSet] = await Promise.all([getVendorLookup(), resolveProductCdSet(filters)]);
  const rows = await fetchSalesRangeCached(rangeStart, rangeEnd, productCdSet);

  const rowFilter = buildRowFilter({ dept: filters.dept, channels: filters.channels, vendorLookup });

  const byRegion = new Map();
  for (const row of rows) {
    if (!rowFilter(row)) continue;
    const region = vendorLookup.get(row.ven_cd)?.sido || "미분류";
    byRegion.set(region, (byRegion.get(region) || 0) + (Number(row.price) || 0));
  }

  return [...byRegion.entries()]
    .map(([region, amount]) => ({ region, amount: amount / 100000000 }))
    .sort((a, b) => b.amount - a.amount);
}

async function getDeptSales(filters = {}) {
  const mk = clampMonth(filters.month || monthKey(new Date().toISOString().slice(0, 10)));
  const rangeStart = `${mk}-01`;
  const rangeEnd = `${shiftMonth(mk, 1)}-01`;

  const [vendorLookup, productCdSet] = await Promise.all([getVendorLookup(), resolveProductCdSet(filters)]);
  const rows = await fetchSalesRangeCached(rangeStart, rangeEnd, productCdSet);

  const rowFilter = buildRowFilter({ region: filters.region, channels: filters.channels, vendorLookup });

  const byDept = new Map();
  for (const row of rows) {
    if (!rowFilter(row)) continue;
    const dept = vendorLookup.get(row.ven_cd)?.subject || "미분류";
    byDept.set(dept, (byDept.get(dept) || 0) + (Number(row.price) || 0));
  }

  return [...byDept.entries()]
    .map(([dept, amount]) => ({ dept, amount: amount / 100000000 }))
    .sort((a, b) => b.amount - a.amount);
}

async function computeFirstPurchaseMap(filters) {
  const productCdSet = await resolveProductCdSet(filters);
  if (productCdSet && productCdSet.size === 0) return new Map();

  const vendorLookup = await getVendorLookup();
  const supabase = getSupabase();
  const pageSize = 1000;
  let from = 0;
  const firstSeen = new Map();
  const channelSet = filters.channels && filters.channels.length ? new Set(filters.channels) : null;

  for (;;) {
    let query = supabase
      .from("dream_vendor_product_first_sale")
      .select("ven_cd, product_cd, sale_type, first_date")
      .order("first_date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (productCdSet) query = query.in("product_cd", [...productCdSet]);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    for (const row of data) {
      if (!row.ven_cd) continue;
      if (channelSet) {
        const bucket = row.sale_type === "매출" ? "병의원" : "도매";
        if (!channelSet.has(bucket)) continue;
      }
      if (filters.region || filters.dept) {
        const info = vendorLookup.get(row.ven_cd);
        if (filters.region && (!info || info.sido !== filters.region)) continue;
        if (filters.dept && (!info || info.subject !== filters.dept)) continue;
      }
      if (!firstSeen.has(row.ven_cd)) firstSeen.set(row.ven_cd, monthKey(row.first_date));
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return firstSeen;
}

function getFirstPurchaseMap(filters) {
  const key = `firstPurchase:${JSON.stringify({
    company: filters.company || null,
    product: filters.product || null,
    region: filters.region || null,
    dept: filters.dept || null,
    channels: filters.channels || null,
  })}`;
  return getOrSet(key, FIRST_PURCHASE_TTL, () => computeFirstPurchaseMap(filters));
}

async function getNewBuyers(filters = {}) {
  const mk = clampMonth(filters.month || monthKey(new Date().toISOString().slice(0, 10)));

  if (canUseBuyerMart(filters)) return getNewBuyersFromMart(filters, mk);

  const monthList = lastNMonthKeys(3, mk);

  const [firstSeenMap, vendorLookup] = await Promise.all([getFirstPurchaseMap(filters), getVendorLookup()]);

  const monthly = monthList.map((m) => {
    let count = 0;
    for (const fm of firstSeenMap.values()) if (fm === m) count += 1;
    return { month: m, count };
  });

  const currentMonthVendors = [...firstSeenMap.entries()].filter(([, fm]) => fm === mk).map(([venCd]) => venCd);
  const prevMonthCount = monthly[monthly.length - 2]?.count || 0;
  const currentCount = monthly[monthly.length - 1]?.count || 0;

  let top5 = [];
  if (currentMonthVendors.length > 0) {
    const rangeStart = `${mk}-01`;
    const rangeEnd = `${shiftMonth(mk, 1)}-01`;
    const productCdSet = await resolveProductCdSet(filters);
    const rows = await fetchSalesRangeCached(rangeStart, rangeEnd, productCdSet);
    const rowFilter = buildRowFilter({ region: filters.region, dept: filters.dept, channels: filters.channels, vendorLookup });
    const vendorSet = new Set(currentMonthVendors);

    const byVendor = new Map();
    for (const row of rows) {
      if (!vendorSet.has(row.ven_cd)) continue;
      if (!rowFilter(row)) continue;
      if (!byVendor.has(row.ven_cd)) {
        const info = vendorLookup.get(row.ven_cd);
        byVendor.set(row.ven_cd, { name: info?.name || row.ven_cd, dept: info?.subject || "", amount: 0 });
      }
      byVendor.get(row.ven_cd).amount += Number(row.price) || 0;
    }

    top5 = [...byVendor.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map(({ name, dept }) => ({ name, dept }));
  }

  return {
    total: currentCount,
    delta: currentCount - prevMonthCount,
    monthly,
    top5,
  };
}

// ===== mart_buyer_monthly 연동 =====
// company(제약사)가 선택되어 있고, product(상품 단위 세부 필터)와 channels(매출유형 필터)가
// 걸려있지 않을 때만 mart_buyer_monthly를 쓴다. 마트의 그레인이 (파트너×거래처×월)이라
// 상품/매출유형 세부 필터는 표현할 수 없기 때문 — 그 경우는 기존 라이브 계산 경로로 그대로 처리한다.
function canUseBuyerMart(filters) {
  return Boolean(filters.company) && !filters.product && !channelsToSaleTypes(filters.channels);
}

function getPartnerIdByGroupNm(groupNm) {
  return getOrSet(`partnerId:${groupNm}`, PARTNER_ID_TTL, async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase.from("dream_partner").select("id").eq("group_nm", groupNm).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? data.id : null;
  });
}

function fetchMartRows(partnerId, startYm, endYm, columns) {
  const key = `mart:${partnerId}:${startYm}:${endYm}:${columns}`;
  return getOrSet(key, MART_TTL, async () => {
    const supabase = getSupabase();
    const pageSize = 1000;
    let from = 0;
    const rows = [];
    for (;;) {
      const { data, error } = await supabase
        .from("mart_buyer_monthly")
        .select(columns)
        .eq("partner_id", partnerId)
        .gte("ym", startYm)
        .lte("ym", endYm)
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  });
}

function buildVendorPassFilter({ region, dept, vendorLookup }) {
  if (!region && !dept) return () => true;
  return (venCd) => {
    const info = vendorLookup.get(venCd);
    if (region && (!info || info.sido !== region)) return false;
    if (dept && (!info || info.subject !== dept)) return false;
    return true;
  };
}

async function getBuyerTrendFromMart(filters, endMonth) {
  const months12 = lastNMonthKeys(BUYER_TREND_MONTHS, endMonth);
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) return { months12, new: months12.map(() => 0), repurchase: months12.map(() => 0), dormant: months12.map(() => 0) };

  const startYm = `${months12[0]}-01`;
  const endYm = `${endMonth}-01`;
  const [rows, vendorLookup] = await Promise.all([
    fetchMartRows(partnerId, startYm, endYm, "ym,ven_cd,is_new_buyer,is_repurchase,dormant_days"),
    getVendorLookup(),
  ]);
  const passesFilter = buildVendorPassFilter({ region: filters.region, dept: filters.dept, vendorLookup });

  const byMonth = new Map(months12.map((mk) => [mk, { new: 0, repurchase: 0, dormant: 0 }]));
  for (const r of rows) {
    if (!passesFilter(r.ven_cd)) continue;
    const bucket = byMonth.get(monthKey(r.ym));
    if (!bucket) continue;
    if (r.is_new_buyer) bucket.new += 1;
    else if (r.is_repurchase) bucket.repurchase += 1;
    if (r.dormant_days >= 90) bucket.dormant += 1;
  }

  return {
    months12,
    new: months12.map((mk) => byMonth.get(mk).new),
    repurchase: months12.map((mk) => byMonth.get(mk).repurchase),
    dormant: months12.map((mk) => byMonth.get(mk).dormant),
  };
}

async function getBuyerSegmentsFromMart(filters, endMonth) {
  const prevMonth = shiftMonth(endMonth, -1);
  const months12 = lastNMonthKeys(BUYER_TREND_MONTHS, endMonth);
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) {
    const emptySegments = SEGMENT_ORDER.map((seg) => ({ seg, count: 0, pct: 0, deltaCount: 0 }));
    return { segments: emptySegments, heatmap12: { months: months12, rows: SEGMENT_ORDER.map((seg) => ({ seg, values: months12.map(() => 0), avgCycleDays: null })) } };
  }

  const startYm = `${months12[0]}-01`;
  const endYm = `${endMonth}-01`;
  const [rows, vendorLookup] = await Promise.all([
    fetchMartRows(partnerId, startYm, endYm, "ym,ven_cd,order_count,rfm_segment"),
    getVendorLookup(),
  ]);
  const passesFilter = buildVendorPassFilter({ region: filters.region, dept: filters.dept, vendorLookup });

  const byVendorMonthOrders = new Map(); // ven_cd -> Map(ym -> order_count)
  const segByVendorMonth = new Map(); // ven_cd -> Map(ym -> segment)
  for (const r of rows) {
    if (!passesFilter(r.ven_cd)) continue;
    const mk = monthKey(r.ym);
    if (!byVendorMonthOrders.has(r.ven_cd)) byVendorMonthOrders.set(r.ven_cd, new Map());
    byVendorMonthOrders.get(r.ven_cd).set(mk, r.order_count);
    if (!segByVendorMonth.has(r.ven_cd)) segByVendorMonth.set(r.ven_cd, new Map());
    segByVendorMonth.get(r.ven_cd).set(mk, r.rfm_segment);
  }

  const currCounts = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, 0]));
  const prevCounts = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, 0]));
  const currAssign = new Map();
  for (const [venCd, segMap] of segByVendorMonth) {
    const currSeg = segMap.get(endMonth);
    if (currSeg) {
      currCounts[currSeg] += 1;
      currAssign.set(venCd, currSeg);
    }
    const prevSeg = segMap.get(prevMonth);
    if (prevSeg) prevCounts[prevSeg] += 1;
  }

  const total = Object.values(currCounts).reduce((a, b) => a + b, 0) || 1;
  const segments = SEGMENT_ORDER.map((seg) => ({
    seg,
    count: currCounts[seg],
    pct: Math.round((currCounts[seg] / total) * 100),
    deltaCount: currCounts[seg] - prevCounts[seg],
  }));

  const heatmapRows = SEGMENT_ORDER.map((seg) => {
    const vendorsInSeg = [...currAssign.entries()].filter(([, s]) => s === seg).map(([venCd]) => venCd);
    const values = months12.map((mk) => {
      // 세그먼트 전체 인원으로 나누면 큰 세그먼트(예: 이탈위험 수천 곳)는 그달 실제
      // 구매자가 소수여도 평균이 0으로 희석된다. 그달 실제 구매한 거래처 수로만 나눈다.
      let sum = 0, activeCount = 0;
      for (const venCd of vendorsInSeg) {
        const oc = byVendorMonthOrders.get(venCd)?.get(mk);
        if (oc) { sum += oc; activeCount += 1; }
      }
      if (!activeCount) return 0;
      return Math.max(0, Math.min(5, Math.round(sum / activeCount)));
    });
    const avgCycleDays = avgCycleDaysForSegment(vendorsInSeg, months12, (venCd, mk) => byVendorMonthOrders.get(venCd)?.get(mk));
    return { seg, values, avgCycleDays };
  });

  return { segments, heatmap12: { months: months12, rows: heatmapRows } };
}

async function getNewBuyersFromMart(filters, mk) {
  const monthList = lastNMonthKeys(3, mk);
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) return { total: 0, delta: 0, monthly: monthList.map((m) => ({ month: m, count: 0 })), top5: [] };

  const startYm = `${monthList[0]}-01`;
  const endYm = `${mk}-01`;
  const [rows, vendorLookup] = await Promise.all([
    fetchMartRows(partnerId, startYm, endYm, "ym,ven_cd,is_new_buyer,total_sales"),
    getVendorLookup(),
  ]);
  const passesFilter = buildVendorPassFilter({ region: filters.region, dept: filters.dept, vendorLookup });

  const monthly = monthList.map((m) => ({ month: m, count: 0 }));
  const monthIndex = new Map(monthList.map((m, i) => [m, i]));
  const currentMonthNewRows = [];

  for (const r of rows) {
    if (!r.is_new_buyer || !passesFilter(r.ven_cd)) continue;
    const mkRow = monthKey(r.ym);
    const idx = monthIndex.get(mkRow);
    if (idx === undefined) continue;
    monthly[idx].count += 1;
    if (mkRow === mk) currentMonthNewRows.push(r);
  }

  const prevMonthCount = monthly[monthly.length - 2]?.count || 0;
  const currentCount = monthly[monthly.length - 1]?.count || 0;

  const top5 = currentMonthNewRows
    .sort((a, b) => Number(b.total_sales) - Number(a.total_sales))
    .slice(0, 5)
    .map((r) => {
      const info = vendorLookup.get(r.ven_cd);
      return { name: info?.name || r.ven_cd, dept: info?.subject || "" };
    });

  return { total: currentCount, delta: currentCount - prevMonthCount, monthly, top5 };
}

// ===== 구매처 분석 (RFM 세그먼트 / 신규·재구매·휴면 추이) =====
// 세그먼트 정의(PRD 5.3 S04, 7.3): 트레일링 6개월 구매빈도(F)·구매금액(M)과
// 마지막 구매 후 경과월(R, 휴면전환율 정의의 90일≈3개월 기준)로 분류한다.
//   - 이탈위험: 마지막 구매가 3개월 이상 지난 거래처
//   - (3개월 이내 활동) 충성: F>=4 / 일반: F 2~3 / 단발·관심: F==1 (6개월 매출액이
//     동일 F==1 그룹 중앙값 이상이면 단발, 미만이면 관심)
const SEGMENT_ORDER = ["충성", "일반", "단발", "관심", "이탈위험"];
const BUYER_TREND_MONTHS = 12;
const BUYER_LOOKBACK_MONTHS = 16; // 12개월 표시 + 휴면(3개월 갭) 판정용 여유
const DORMANT_GAP_MONTHS = 3;

// 세그먼트 내 거래처들의 "평균 구매주기"를 히트맵 표시 구간(monthsWindow) 안에서 계산한다.
// 거래처별로 주문이 있던 달(getOrderCount>0)의 인덱스를 모아 연속한 활동월 사이의
// 간격을 구하고, 마지막 활동월부터 구간 끝(현재)까지의 공백도 하나의 간격으로 포함한다 —
// 이걸 빼면 이탈위험처럼 최근엔 계속 안 사는 세그먼트가 "예전에 반짝 활동했던 사이 간격"만
// 평균에 잡혀 오히려 짧게 나오는 오류가 생긴다. 활동월이 1개뿐인 거래처도 "그 달부터
// 지금까지의 공백" 하나로 계산에 포함시킨다. 활동이 전혀 없는 거래처만 제외한다.
function avgCycleDaysForSegment(vendorsInSeg, monthsWindow, getOrderCount) {
  const lastIdx = monthsWindow.length - 1;
  const gaps = [];
  for (const venCd of vendorsInSeg) {
    const activeIdx = [];
    monthsWindow.forEach((mk, i) => {
      if ((getOrderCount(venCd, mk) || 0) > 0) activeIdx.push(i);
    });
    if (!activeIdx.length) continue;
    const intervals = [];
    for (let k = 1; k < activeIdx.length; k++) intervals.push(activeIdx[k] - activeIdx[k - 1]);
    intervals.push(lastIdx - activeIdx[activeIdx.length - 1]); // 마지막 구매 이후 현재까지의 공백
    gaps.push(intervals.reduce((a, b) => a + b, 0) / intervals.length);
  }
  if (!gaps.length) return null;
  const avgMonths = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return Math.round(avgMonths * 30);
}

function fetchBuyerMonthlyMatrix(rangeStart, rangeEnd, { productCdSet, region, dept, saleTypes }) {
  const key = `buyerMatrix:${rangeStart}:${rangeEnd}:${productCdSet ? [...productCdSet].sort().join(",") : "all"}:${
    region || "all"
  }:${dept || "all"}:${saleTypes ? saleTypes.slice().sort().join(",") : "all"}`;

  return getOrSet(key, SALES_TTL, async () => {
    const supabase = getSupabase();
    const pageSize = 1000;
    let from = 0;
    const rows = [];
    for (;;) {
      const { data, error } = await supabase
        .rpc("dashboard_buyer_monthly_agg", {
          range_start: rangeStart,
          range_end: rangeEnd,
          product_cds: productCdSet ? [...productCdSet] : null,
          region: region || null,
          dept: dept || null,
          sale_types: saleTypes,
        })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  });
}

// 거래처별 월간 활동 매트릭스: ven_cd -> Map(month -> {price, orderCount})
async function getBuyerActivity(filters, endMonth) {
  const rangeStartMonth = shiftMonth(endMonth, -(BUYER_LOOKBACK_MONTHS - 1));
  const rangeStart = `${rangeStartMonth}-01`;
  const rangeEnd = `${shiftMonth(endMonth, 1)}-01`;
  const saleTypes = channelsToSaleTypes(filters.channels);

  const productCdSet = await resolveProductCdSet(filters);
  const [rows, firstSeenMap] = await Promise.all([
    fetchBuyerMonthlyMatrix(rangeStart, rangeEnd, { productCdSet, region: filters.region, dept: filters.dept, saleTypes }),
    getFirstPurchaseMap(filters),
  ]);

  const byVendor = new Map();
  for (const r of rows) {
    const mk = monthKey(r.month);
    if (!byVendor.has(r.ven_cd)) byVendor.set(r.ven_cd, new Map());
    byVendor.get(r.ven_cd).set(mk, { price: Number(r.price) || 0, orderCount: Number(r.order_count) || 0 });
  }

  return { byVendor, firstSeenMap, rangeStartMonth };
}

async function getBuyerTrend(filters = {}) {
  const endMonth = clampMonth(filters.month || monthKey(new Date().toISOString().slice(0, 10)));

  if (canUseBuyerMart(filters)) return getBuyerTrendFromMart(filters, endMonth);

  const months12 = lastNMonthKeys(BUYER_TREND_MONTHS, endMonth);
  const displaySet = new Set(months12);
  const { byVendor, firstSeenMap, rangeStartMonth } = await getBuyerActivity(filters, endMonth);

  const monthsInWindow = [];
  for (let mk = rangeStartMonth; mk <= endMonth; mk = shiftMonth(mk, 1)) monthsInWindow.push(mk);

  const lastActive = new Map(); // ven_cd -> 지금까지 훑은 범위에서의 마지막 활동월
  const series = { new: [], repurchase: [], dormant: [] };

  for (const mk of monthsInWindow) {
    const activeVendorsThisMonth = [];
    for (const [venCd, monthly] of byVendor) {
      if (monthly.has(mk)) {
        activeVendorsThisMonth.push(venCd);
        lastActive.set(venCd, mk);
      }
    }

    if (!displaySet.has(mk)) continue;

    let newCount = 0;
    let repurchaseCount = 0;
    for (const venCd of activeVendorsThisMonth) {
      if (firstSeenMap.get(venCd) === mk) newCount += 1;
      else repurchaseCount += 1;
    }

    let dormantCount = 0;
    for (const [venCd, firstMonth] of firstSeenMap) {
      if (firstMonth >= mk) continue; // 이 시점엔 아직 고객이 아니었음
      const last = lastActive.get(venCd);
      const gap = last ? monthDiff(mk, last) : Infinity;
      if (gap >= DORMANT_GAP_MONTHS) dormantCount += 1;
    }

    series.new.push(newCount);
    series.repurchase.push(repurchaseCount);
    series.dormant.push(dormantCount);
  }

  return { months12, ...series };
}

function classifyVendors(byVendor, firstSeenMap, asOfMonth) {
  const windowSet = new Set(lastNMonthKeys(6, asOfMonth));

  const stats = [];
  for (const [venCd, monthly] of byVendor) {
    const firstMonth = firstSeenMap.get(venCd);
    if (!firstMonth || firstMonth > asOfMonth) continue; // 이 시점엔 아직 고객이 아니었음

    let lastActiveMonth = null;
    let freq6 = 0;
    let monetary6 = 0;
    for (const [mk, v] of monthly) {
      if (mk > asOfMonth) continue;
      if (!lastActiveMonth || mk > lastActiveMonth) lastActiveMonth = mk;
      if (windowSet.has(mk)) {
        freq6 += 1;
        monetary6 += v.price;
      }
    }
    const gapMonths = lastActiveMonth ? monthDiff(asOfMonth, lastActiveMonth) : Infinity;
    stats.push({ venCd, freq6, monetary6, gapMonths });
  }

  const recent = stats.filter((s) => s.gapMonths < DORMANT_GAP_MONTHS);
  const churn = stats.filter((s) => s.gapMonths >= DORMANT_GAP_MONTHS);

  const onceOnlyAmounts = recent
    .filter((s) => s.freq6 === 1)
    .map((s) => s.monetary6)
    .sort((a, b) => a - b);
  const medianOnce = onceOnlyAmounts.length ? onceOnlyAmounts[Math.floor(onceOnlyAmounts.length / 2)] : 0;

  const assign = new Map();
  for (const s of recent) {
    let seg;
    if (s.freq6 >= 4) seg = "충성";
    else if (s.freq6 >= 2) seg = "일반";
    else if (s.monetary6 >= medianOnce) seg = "단발";
    else seg = "관심";
    assign.set(s.venCd, seg);
  }
  for (const s of churn) assign.set(s.venCd, "이탈위험");

  return assign;
}

async function getBuyerSegments(filters = {}) {
  const endMonth = clampMonth(filters.month || monthKey(new Date().toISOString().slice(0, 10)));

  if (canUseBuyerMart(filters)) return getBuyerSegmentsFromMart(filters, endMonth);

  const prevMonth = shiftMonth(endMonth, -1);
  const { byVendor, firstSeenMap } = await getBuyerActivity(filters, endMonth);

  const currAssign = classifyVendors(byVendor, firstSeenMap, endMonth);
  const prevAssign = classifyVendors(byVendor, firstSeenMap, prevMonth);

  const currCounts = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, 0]));
  for (const seg of currAssign.values()) currCounts[seg] += 1;
  const prevCounts = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, 0]));
  for (const seg of prevAssign.values()) prevCounts[seg] += 1;

  const total = Object.values(currCounts).reduce((a, b) => a + b, 0) || 1;
  const segments = SEGMENT_ORDER.map((seg) => ({
    seg,
    count: currCounts[seg],
    pct: Math.round((currCounts[seg] / total) * 100),
    deltaCount: currCounts[seg] - prevCounts[seg],
  }));

  const months12 = lastNMonthKeys(BUYER_TREND_MONTHS, endMonth);
  const rows = SEGMENT_ORDER.map((seg) => {
    const vendorsInSeg = [...currAssign.entries()].filter(([, s]) => s === seg).map(([venCd]) => venCd);
    const values = months12.map((mk) => {
      // 세그먼트 전체 인원으로 나누면 큰 세그먼트(예: 이탈위험 수천 곳)는 그달 실제
      // 구매자가 소수여도 평균이 0으로 희석된다. 그달 실제 구매한 거래처 수로만 나눈다.
      let sum = 0, activeCount = 0;
      for (const venCd of vendorsInSeg) {
        const v = byVendor.get(venCd)?.get(mk);
        if (v) { sum += v.orderCount; activeCount += 1; }
      }
      if (!activeCount) return 0;
      return Math.max(0, Math.min(5, Math.round(sum / activeCount)));
    });
    const avgCycleDays = avgCycleDaysForSegment(vendorsInSeg, months12, (venCd, mk) => byVendor.get(venCd)?.get(mk)?.orderCount);
    return { seg, values, avgCycleDays };
  });

  return { segments, heatmap12: { months: months12, rows } };
}

async function getCompanies() {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("dream_partner").select("group_nm").order("group_nm", { ascending: true });
  if (error) throw new Error(error.message);
  return data.map((row) => row.group_nm);
}

async function getCompanyProducts(groupNm) {
  const catalog = await getProductCatalog();
  return catalog
    .filter((p) => p.group_nm === groupNm)
    .map((p) => ({ code: p.physic_cd, name: p.physic_nm }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

async function getDistinctRegions() {
  const vendorLookup = await getVendorLookup();
  return [...new Set([...vendorLookup.values()].map((v) => v.sido))].sort((a, b) => a.localeCompare(b, "ko"));
}

async function getDistinctDepts() {
  const vendorLookup = await getVendorLookup();
  return [...new Set([...vendorLookup.values()].map((v) => v.subject))].sort((a, b) => a.localeCompare(b, "ko"));
}

// ===== 캠페인 성과 (S06) =====
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function toEok(v) {
  return Math.round((v / 100000000) * 100) / 100;
}

// 진료과는 dream_vendor_sales/dream_product에는 없고 dream_vendor.subject에만 있어서
// RPC 단계에서 필터할 수 없다. 거래처별로 집계된 결과를 받은 뒤 JS에서 걸러낸다
// (getDeptSales 등 기존 화면들과 동일한 방식).
async function computeCampaignPeriodStats(partnerId, rangeStart, rangeEnd, productCd, targetDept, vendorLookup) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("dashboard_period_buyer_agg", {
    p_partner_id: partnerId,
    range_start: rangeStart,
    range_end: rangeEnd,
    p_product_cd: productCd || null,
  });
  if (error) throw new Error(error.message);
  const rows = targetDept
    ? data.filter((r) => vendorLookup.get(r.ven_cd)?.subject === targetDept)
    : data;
  const buyers = new Set(rows.map((r) => r.ven_cd));
  const totalSales = rows.reduce((sum, r) => sum + (Number(r.price) || 0), 0);
  return { buyers, totalSales };
}

// Uplift = 캠페인 기간 매출 - 직전 동일 기간 매출, ROI = (Uplift - 예산) / 예산 × 100 (PRD 정의 그대로).
// 신규 구매처 = 캠페인 기간엔 샀지만 직전 기간엔 안 산 거래처. 재구매율 = 직전 기간 구매처 중
// 캠페인 기간에도 다시 산 비율 — 캠페인이라는 한 이벤트를 기준으로 한 전/후 비교이므로,
// 거래처의 평생 첫구매 여부가 아니라 이 두 기간만 비교한다.
async function computeCampaignPerformance(partnerId, campaign) {
  const { start_date: startDate, end_date: endDate, target_product_code: targetProductCode, target_dept: targetDept, budget } = campaign;
  const campaignRangeEnd = addDays(endDate, 1);
  const lengthDays = daysBetween(startDate, endDate) + 1;
  const priorRangeStart = addDays(startDate, -lengthDays);
  const priorRangeEnd = startDate;

  const vendorLookup = targetDept ? await getVendorLookup() : null;
  const [curr, prior] = await Promise.all([
    computeCampaignPeriodStats(partnerId, startDate, campaignRangeEnd, targetProductCode, targetDept, vendorLookup),
    computeCampaignPeriodStats(partnerId, priorRangeStart, priorRangeEnd, targetProductCode, targetDept, vendorLookup),
  ]);

  // targetProductCode가 없으면 Uplift가 파트너 전체 매출 기준이라 캠페인 예산과 비교할
  // 근거가 없다 (회사 전체 매출은 예산과 무관하게 매달 수천만~수억 단위로 자연 변동한다).
  // 이 경우 ROI는 계산하지 않고 Uplift(매출 변동액)만 보여준다.
  const upliftRaw = curr.totalSales - prior.totalSales;
  const roiPct = budget > 0 && targetProductCode ? Math.round(((upliftRaw - budget) / budget) * 1000) / 10 : null;
  const newBuyerCount = [...curr.buyers].filter((v) => !prior.buyers.has(v)).length;
  const repeatBuyerCount = [...curr.buyers].filter((v) => prior.buyers.has(v)).length;
  const repurchaseRatePct = prior.buyers.size > 0 ? Math.round((repeatBuyerCount / prior.buyers.size) * 1000) / 10 : null;

  return {
    currSalesEok: toEok(curr.totalSales),
    priorSalesEok: toEok(prior.totalSales),
    upliftEok: toEok(upliftRaw),
    roiPct,
    currBuyerCount: curr.buyers.size,
    priorBuyerCount: prior.buyers.size,
    newBuyerCount,
    repurchaseRatePct,
    comparePeriodStart: priorRangeStart,
    comparePeriodEnd: addDays(priorRangeEnd, -1),
  };
}

async function getCampaigns(filters = {}) {
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) return [];

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("dim_campaign")
    .select("id, campaign_name, campaign_type, start_date, end_date, target_product_code, budget, target_segment, target_dept, created_at")
    .eq("partner_id", partnerId)
    .order("start_date", { ascending: false });
  if (error) throw new Error(error.message);

  return Promise.all(
    data.map(async (c) => ({
      ...c,
      budgetEok: toEok(Number(c.budget) || 0),
      ...(await computeCampaignPerformance(partnerId, c)),
    }))
  );
}

async function createCampaign(filters, payload) {
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) throw new Error("회사를 먼저 선택하세요.");
  if (!payload.campaignName) throw new Error("캠페인명을 입력하세요.");
  if (!payload.startDate || !payload.endDate) throw new Error("캠페인 기간을 입력하세요.");

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("dim_campaign")
    .insert({
      partner_id: partnerId,
      campaign_name: payload.campaignName,
      campaign_type: payload.campaignType || null,
      start_date: payload.startDate,
      end_date: payload.endDate,
      target_product_code: payload.targetProductCode || null,
      budget: payload.budget || 0,
      target_segment: payload.targetSegment || null,
      target_dept: payload.targetDept || null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteCampaign(filters, campaignId) {
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) throw new Error("회사를 먼저 선택하세요.");
  const id = Number(campaignId);
  if (!Number.isInteger(id)) throw new Error("잘못된 캠페인 id입니다.");

  const supabase = getSupabase();
  // partner_id도 함께 걸어서, 다른 회사 소속 캠페인 id를 잘못 넘겨도 지워지지 않게 한다.
  const { data, error } = await supabase
    .from("dim_campaign")
    .delete()
    .eq("id", id)
    .eq("partner_id", partnerId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("해당 캠페인을 찾을 수 없습니다.");
  return { ok: true };
}

// ===== 파트너 히스토리 (S08) =====
async function getPartnerHistory(filters = {}) {
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) return [];

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("partner_history_entries")
    .select("id, entry_date, entry_type, content, created_at")
    .eq("partner_id", partnerId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

async function addPartnerHistoryEntry(filters, payload) {
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) throw new Error("회사를 먼저 선택하세요.");
  if (!payload.content) throw new Error("내용을 입력하세요.");
  if (!payload.entryDate) throw new Error("날짜를 입력하세요.");

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("partner_history_entries")
    .insert({
      partner_id: partnerId,
      entry_date: payload.entryDate,
      entry_type: payload.entryType || "메모",
      content: payload.content,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getPartnerReportDownloads(filters = {}) {
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) return [];

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("partner_report_downloads")
    .select("id, report_type, tab_name, downloaded_at")
    .eq("partner_id", partnerId)
    .order("downloaded_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data;
}

// 회사가 아직 선택 안 된 상태로 다운로드하면 partnerId가 없어 조용히 스킵한다 —
// 로그 기록 실패로 실제 PDF/PPT 다운로드 자체를 막을 이유는 없다.
async function logPartnerReportDownload(filters, payload) {
  const partnerId = await getPartnerIdByGroupNm(filters.company);
  if (partnerId == null) return null;

  const supabase = getSupabase();
  const { error } = await supabase.from("partner_report_downloads").insert({
    partner_id: partnerId,
    report_type: payload.reportType,
    tab_name: payload.tabName || null,
  });
  if (error) throw new Error(error.message);
  return true;
}

module.exports = {
  getKpiTrend,
  getSalesTypeTrend,
  getRegionSales,
  getDeptSales,
  getNewBuyers,
  getBuyerTrend,
  getBuyerSegments,
  getCompanies,
  getCompanyProducts,
  getDistinctRegions,
  getDistinctDepts,
  getCampaigns,
  createCampaign,
  deleteCampaign,
  getPartnerHistory,
  addPartnerHistoryEntry,
  getPartnerReportDownloads,
  logPartnerReportDownload,
};
