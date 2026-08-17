const Anthropic = require("@anthropic-ai/sdk");
const config = require("../config");
const { getOrSet } = require("./cache");
const { getKpiTrend, getRegionSales, getDeptSales, getBuyerSegments, getSalesTypeTrend, getNewBuyers } = require("./dashboardQueries");

const AI_SUMMARY_TTL = 6 * 60 * 60 * 1000; // PRD의 "매일 새벽 03:00 갱신"을 단순화한 캐시 주기
const MODEL = "claude-sonnet-5";

const SUMMARY_TOOL = {
  name: "submit_dashboard_summary",
  description: "대시보드 AI 인사이트 결과를 제출한다. 모든 문장은 마크업이나 태그 없이 순수 텍스트로만 작성한다.",
  input_schema: {
    type: "object",
    properties: {
      top3: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
        description: "공통 필터 영역 상단에 표시할 핵심 인사이트 3개 — 성장 요인/리스크/추천 실행과제 순으로 각 1개의 완결된 문장, 반드시 수치를 포함. 순수 텍스트만, 태그나 마크업 금지.",
      },
      summaryLines: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
        description: "매출 대시보드 탭 하단 '대시보드 분석 요약' 카드에 표시할 문장 3개, 각각 배열의 독립된 원소로 — 순서대로 핵심 변화 원인 / 리스크·기회 / 다음 액션. 각 원소는 그 자체로 완결된 한 문장이며, 순수 텍스트만 사용하고 태그·마크업·다른 원소 참조를 포함하지 않는다.",
      },
    },
    required: ["top3", "summaryLines"],
  },
};

function cardSchema(desc) {
  return {
    type: "object",
    properties: {
      hasData: { type: "boolean", description: "이 카드에 실제 근거 데이터가 있는지 여부. 근거 데이터가 없으면 false." },
      body: { type: "string", description: `${desc} 본문. 순수 텍스트만, 태그·마크업 금지. hasData=false면 지어내지 말고 데이터가 없다는 사실만 짧게 적을 것.` },
      action: { type: "string", description: "카드 하단에 표시할 추천 실행 한 줄. hasData=false면 빈 문자열." },
    },
    required: ["hasData", "body", "action"],
  };
}

const INSIGHT_TAB_TOOL = {
  name: "submit_ai_insight_tab",
  description: "AI 인사이트 탭의 Executive Summary·인사이트 카드 6종·추천 실행과제를 제출한다. 모든 문장은 마크업이나 태그 없이 순수 텍스트로만 작성한다.",
  input_schema: {
    type: "object",
    properties: {
      executiveSummary: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
        description: "상단 Executive Summary에 표시할 문장 3개, 배열의 독립된 원소로 — 순서대로 성장 요인 / 리스크 / 다음 과제. 각 원소는 완결된 한 문장이며 순수 텍스트만.",
      },
      cards: {
        type: "object",
        description: "6종 인사이트 카드. growth/risk/customer/channel은 실제 데이터가 제공되므로 반드시 hasData=true로 구체적 수치를 포함해 작성한다. product/competitor는 근거 데이터가 제공되지 않으므로 반드시 hasData=false로 하고 짧은 안내만 담는다 — 절대로 수치를 지어내지 않는다.",
        properties: {
          growth: cardSchema("성장 요인 인사이트"),
          risk: cardSchema("리스크 인사이트"),
          product: cardSchema("제품 인사이트"),
          customer: cardSchema("고객 행동 인사이트"),
          channel: cardSchema("채널(병의원/도매) 인사이트"),
          competitor: cardSchema("경쟁품 인사이트"),
        },
        required: ["growth", "risk", "product", "customer", "channel", "competitor"],
      },
      actionItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "실행 과제 내용, 완결된 한 문장, 수치 포함" },
            effect: { type: "string", description: "기대 효과 한 줄. 실제 데이터에서 나온 것만 — 전환율 예측치 같은 지어낸 수치 금지" },
          },
          required: ["text", "effect"],
        },
        minItems: 3,
        maxItems: 5,
        description: "우선순위 추천 실행과제 3~5개. 판매 지표·세그먼트·채널 데이터 중 하나라도 제공되었다면 절대 빈 배열을 반환하지 말 것 — 그 데이터를 근거로 최소 3개를 반드시 작성한다. product/competitor처럼 근거가 전혀 없는 항목만 비워도 되는 예외이고, actionItems 자체를 비우는 것은 허용되지 않는다.",
      },
    },
    required: ["executiveSummary", "cards", "actionItems"],
  },
};

// 모델이 가끔 응답 끝에 엉뚱한 태그(예: </summary>, <parameter ...>)를 덧붙이는 경우가 있어,
// 화면에 그대로 노출되지 않도록 태그 이후는 잘라내고 태그 자체도 제거한다.
function sanitizeText(s) {
  if (typeof s !== "string") return "";
  const tagStart = s.search(/<\/?[a-zA-Z_][^>]*>/);
  const cut = tagStart >= 0 ? s.slice(0, tagStart) : s;
  return cut.replace(/\\n/g, " ").trim();
}

let client = null;
function getClient() {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다 — backend-main/.env에 키를 추가하세요.");
  }
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

function pct(curr, prev) {
  if (!prev) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

function fmtPct(v) {
  if (v === null || v === undefined) return "데이터 부족";
  return `${v > 0 ? "+" : ""}${v}%`;
}

async function buildContext(filters) {
  const [kpi, region, dept, buyerSegments] = await Promise.all([
    getKpiTrend({ ...filters, months: 2, endMonth: filters.month }),
    getRegionSales(filters),
    getDeptSales(filters),
    getBuyerSegments(filters),
  ]);

  const lastIdx = kpi.months.length - 1;
  const prevIdx = lastIdx - 1;
  const churnSeg = buyerSegments.segments.find((s) => s.seg === "이탈위험");

  return {
    period: kpi.months[lastIdx],
    company: filters.company || "전체",
    sales: {
      curr: kpi.sales.curr[lastIdx],
      momPct: pct(kpi.sales.curr[lastIdx], kpi.sales.curr[prevIdx]),
      yoyPct: pct(kpi.sales.curr[lastIdx], kpi.sales.prev[lastIdx]),
    },
    qty: {
      curr: kpi.qty.curr[lastIdx],
      momPct: pct(kpi.qty.curr[lastIdx], kpi.qty.curr[prevIdx]),
    },
    buyerCount: {
      curr: kpi.buyer.curr[lastIdx],
      momPct: pct(kpi.buyer.curr[lastIdx], kpi.buyer.curr[prevIdx]),
    },
    topRegions: region.slice(0, 3),
    topDepts: dept.slice(0, 3),
    churnRisk: churnSeg || null,
    segments: buyerSegments.segments,
  };
}

function buildPrompt(ctx) {
  return `당신은 블루팜코리아 Sales Intelligence Dashboard의 AI 분석가입니다.
아래는 "${ctx.company}" 기준 ${ctx.period} 판매 데이터 요약입니다. 이 수치만 근거로 분석하고, 데이터에 없는 내용은 추측하거나 지어내지 마세요.

- 매출: ${ctx.sales.curr.toFixed(2)}억 (전월비 ${fmtPct(ctx.sales.momPct)}, 전년동월비 ${fmtPct(ctx.sales.yoyPct)})
- 판매수량: ${ctx.qty.curr} (전월비 ${fmtPct(ctx.qty.momPct)})
- 구매처수: ${ctx.buyerCount.curr} (전월비 ${fmtPct(ctx.buyerCount.momPct)})
- 지역별 매출 Top3: ${ctx.topRegions.map((r) => `${r.region} ${r.amount.toFixed(2)}억`).join(", ") || "데이터 없음"}
- 진료과별 매출 Top3: ${ctx.topDepts.map((d) => `${d.dept} ${d.amount.toFixed(2)}억`).join(", ") || "데이터 없음"}
- 구매처 세그먼트(전월대비 증감): ${ctx.segments.map((s) => `${s.seg} ${s.count}곳(${s.deltaCount >= 0 ? "+" : ""}${s.deltaCount})`).join(", ")}

위 도구(submit_dashboard_summary)를 호출해서 결과를 제출하세요.`;
}

async function callClaude(ctx) {
  const anthropic = getClient();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "tool", name: SUMMARY_TOOL.name },
    messages: [{ role: "user", content: buildPrompt(ctx) }],
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse) throw new Error("Claude 응답에서 결과를 찾지 못했습니다.");

  const top3 = (Array.isArray(toolUse.input.top3) ? toolUse.input.top3 : []).map(sanitizeText).filter(Boolean);
  const summaryLines = (Array.isArray(toolUse.input.summaryLines) ? toolUse.input.summaryLines : [])
    .map(sanitizeText)
    .filter(Boolean);

  return { top3, summary: summaryLines.join("\n") };
}

function cacheKeyFor(filters) {
  const channelsKey = filters.channels && filters.channels.length ? filters.channels.slice().sort().join(",") : "all";
  return `aiSummary:${filters.company || "all"}:${filters.product || "all"}:${filters.region || "all"}:${filters.dept || "all"}:${channelsKey}:${filters.month || "current"}`;
}

function getDashboardAiSummary(filters = {}) {
  return getOrSet(cacheKeyFor(filters), AI_SUMMARY_TTL, async () => {
    const ctx = await buildContext(filters);
    return callClaude(ctx);
  });
}

// ===== AI 인사이트 탭 (Executive Summary + 카드 6종 + 추천 실행과제) =====
// 제품별(개별 품목) 매출 추이와 경쟁사 시장점유율(IQVIA 등)은 아직 연동된 데이터 소스가
// 없어 product/competitor 카드는 hasData=false로 고정 안내만 하도록 프롬프트에서 명시한다.
async function buildInsightTabContext(filters) {
  const [kpi, region, dept, buyerSegments, salesType, newBuyers] = await Promise.all([
    getKpiTrend({ ...filters, months: 2, endMonth: filters.month }),
    getRegionSales(filters),
    getDeptSales(filters),
    getBuyerSegments(filters),
    getSalesTypeTrend({ ...filters, months: 2, endMonth: filters.month }),
    getNewBuyers(filters),
  ]);

  const lastIdx = kpi.months.length - 1;
  const prevIdx = lastIdx - 1;
  const churnSeg = buyerSegments.segments.find((s) => s.seg === "이탈위험");

  const currType = salesType[salesType.length - 1];
  const prevType = salesType[salesType.length - 2];
  const wholesaleShare = (t) => (t && t.clinic + t.wholesale > 0 ? (t.wholesale / (t.clinic + t.wholesale)) * 100 : null);
  const currShare = wholesaleShare(currType);
  const prevShare = wholesaleShare(prevType);

  return {
    period: kpi.months[lastIdx],
    company: filters.company || "전체",
    sales: {
      curr: kpi.sales.curr[lastIdx],
      momPct: pct(kpi.sales.curr[lastIdx], kpi.sales.curr[prevIdx]),
      yoyPct: pct(kpi.sales.curr[lastIdx], kpi.sales.prev[lastIdx]),
    },
    qty: {
      curr: kpi.qty.curr[lastIdx],
      momPct: pct(kpi.qty.curr[lastIdx], kpi.qty.curr[prevIdx]),
    },
    buyerCount: {
      curr: kpi.buyer.curr[lastIdx],
      momPct: pct(kpi.buyer.curr[lastIdx], kpi.buyer.curr[prevIdx]),
    },
    newBuyers: { total: newBuyers.total, delta: newBuyers.delta },
    topRegions: region.slice(0, 3),
    topDepts: dept.slice(0, 3),
    segments: buyerSegments.segments,
    churnRisk: churnSeg || null,
    wholesaleSharePct: currShare,
    wholesaleShareDeltaPct: currShare != null && prevShare != null ? Math.round((currShare - prevShare) * 10) / 10 : null,
  };
}

function buildInsightTabPrompt(ctx) {
  return `당신은 블루팜코리아 Sales Intelligence Dashboard의 AI 분석가입니다. "${ctx.company}" 파트너 전용 AI 인사이트 탭에 표시할 내용을 작성합니다.
아래 수치만 근거로 분석하고, 없는 데이터는 절대 추측하거나 지어내지 마세요.

[판매 지표 — ${ctx.period}]
- 매출: ${ctx.sales.curr.toFixed(2)}억 (전월비 ${fmtPct(ctx.sales.momPct)}, 전년동월비 ${fmtPct(ctx.sales.yoyPct)})
- 판매수량: ${ctx.qty.curr} (전월비 ${fmtPct(ctx.qty.momPct)})
- 구매처수: ${ctx.buyerCount.curr} (전월비 ${fmtPct(ctx.buyerCount.momPct)})
- 신규 구매처: ${ctx.newBuyers.total}곳 (전월비 ${ctx.newBuyers.delta >= 0 ? "+" : ""}${ctx.newBuyers.delta})

[지역/진료과]
- 지역별 매출 Top3: ${ctx.topRegions.map((r) => `${r.region} ${r.amount.toFixed(2)}억`).join(", ") || "데이터 없음"}
- 진료과별 매출 Top3: ${ctx.topDepts.map((d) => `${d.dept} ${d.amount.toFixed(2)}억`).join(", ") || "데이터 없음"}

[구매처 세그먼트 — 전월대비 증감]
${ctx.segments.map((s) => `- ${s.seg}: ${s.count}곳 (${s.deltaCount >= 0 ? "+" : ""}${s.deltaCount})`).join("\n")}

[채널 비중 — 도매]
- 도매 비중: ${ctx.wholesaleSharePct != null ? ctx.wholesaleSharePct.toFixed(1) + "%" : "데이터 부족"} (전월비 ${ctx.wholesaleShareDeltaPct != null ? (ctx.wholesaleShareDeltaPct >= 0 ? "+" : "") + ctx.wholesaleShareDeltaPct + "%p" : "데이터 부족"})

[제공되지 않는 데이터 — 반드시 hasData=false로 처리]
- 제품별(개별 품목) 매출/전환율 데이터는 제공되지 않습니다.
- 경쟁사 시장점유율(IQVIA 등) 데이터는 제공되지 않습니다.

위 도구(submit_ai_insight_tab)를 호출해서 결과를 제출하세요.
actionItems는 위에 제공된 판매 지표·지역/진료과·세그먼트·채널 수치를 근거로 최소 3개를 반드시 작성하세요 — 빈 배열([])을 제출하는 것은 허용되지 않습니다. product/competitor 카드처럼 데이터가 없는 항목은 hasData=false로 처리하되, actionItems 자체는 항상 채워야 합니다.`;
}

async function requestInsightTab(ctx) {
  const anthropic = getClient();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [INSIGHT_TAB_TOOL],
    tool_choice: { type: "tool", name: INSIGHT_TAB_TOOL.name },
    messages: [{ role: "user", content: buildInsightTabPrompt(ctx) }],
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse) throw new Error("Claude 응답에서 결과를 찾지 못했습니다.");

  const input = toolUse.input || {};
  const executiveSummary = (Array.isArray(input.executiveSummary) ? input.executiveSummary : [])
    .map(sanitizeText)
    .filter(Boolean);

  const sanitizeCard = (card) => ({
    hasData: Boolean(card && card.hasData),
    body: sanitizeText(card && card.body),
    action: sanitizeText(card && card.action),
  });
  const cards = {};
  for (const key of ["growth", "risk", "product", "customer", "channel", "competitor"]) {
    cards[key] = sanitizeCard(input.cards && input.cards[key]);
  }

  const actionItems = (Array.isArray(input.actionItems) ? input.actionItems : [])
    .map((item) => ({ text: sanitizeText(item && item.text), effect: sanitizeText(item && item.effect) }))
    .filter((item) => item.text);

  return { executiveSummary, cards, actionItems };
}

// tool_choice로 강제해도 minItems 같은 스키마 제약은 100% 보장되지 않아, 모델이 가끔
// actionItems를 빈 배열로 반환한다 — 근거 데이터가 실제로 있는데도 비어 있으면 한 번 더 시도한다.
async function callClaudeForInsightTab(ctx) {
  const result = await requestInsightTab(ctx);
  if (result.actionItems.length > 0) return result;

  const hasAnyRealData = Object.values(result.cards).some((c) => c.hasData);
  if (!hasAnyRealData) return result;

  const retry = await requestInsightTab(ctx);
  return retry.actionItems.length > 0 ? retry : result;
}

function insightTabCacheKeyFor(filters) {
  const channelsKey = filters.channels && filters.channels.length ? filters.channels.slice().sort().join(",") : "all";
  return `aiInsightTab:${filters.company || "all"}:${filters.product || "all"}:${filters.region || "all"}:${filters.dept || "all"}:${channelsKey}:${filters.month || "current"}`;
}

function getAiInsightTab(filters = {}) {
  return getOrSet(insightTabCacheKeyFor(filters), AI_SUMMARY_TTL, async () => {
    const ctx = await buildInsightTabContext(filters);
    return callClaudeForInsightTab(ctx);
  });
}

// ===== 구매처 분석 탭 (Section C: 이탈 리스크 / 퍼널 병목 / 추천 실행과제) =====
// 퍼널 병목은 구매 퍼널 로그 데이터(검색→조회→장바구니→결제)가 아직 연동되지 않아
// 모델에게 판단을 맡기지 않고 항상 hasData=false 고정 문구로 채운다.
function simpleCardSchema(desc) {
  return {
    type: "object",
    properties: {
      hasData: { type: "boolean", description: "이 카드에 실제 근거 데이터가 있는지 여부" },
      body: { type: "string", description: `${desc}. 한 문장, 순수 텍스트만(태그·마크업 금지), 반드시 수치 포함. hasData=false면 지어내지 말고 데이터가 없다는 사실만 짧게.` },
    },
    required: ["hasData", "body"],
  };
}

const BUYER_ANALYSIS_TOOL = {
  name: "submit_buyer_analysis_summary",
  description: "구매처 분석 탭의 AI 요약(이탈 리스크·추천 실행과제)을 제출한다. 마크업이나 태그 없이 순수 텍스트로만 작성한다.",
  input_schema: {
    type: "object",
    properties: {
      churnRisk: simpleCardSchema("구매처 이탈 리스크 요약 — 이탈위험 세그먼트 수·증감을 근거로 리스크 정도와 권장 조치"),
      actionRecommendation: simpleCardSchema("구매처 관리 추천 실행과제 — 관심/단발 등 재구매 유도가 필요한 세그먼트나 신규 구매처 현황을 근거로 한 구체적 실행 제안"),
    },
    required: ["churnRisk", "actionRecommendation"],
  },
};

const FUNNEL_NO_DATA_CARD = { hasData: false, body: "구매 퍼널(검색→조회→장바구니→결제) 로그 데이터가 아직 연동되지 않아 분석할 수 없습니다." };

async function buildBuyerAnalysisContext(filters) {
  const [buyerSegments, newBuyers] = await Promise.all([getBuyerSegments(filters), getNewBuyers(filters)]);

  return {
    company: filters.company || "전체",
    period: filters.month || "이번 달",
    segments: buyerSegments.segments,
    newBuyers: { total: newBuyers.total, delta: newBuyers.delta },
  };
}

function buildBuyerAnalysisPrompt(ctx) {
  return `당신은 블루팜코리아 Sales Intelligence Dashboard의 AI 분석가입니다. "${ctx.company}" 기준 ${ctx.period} 구매처 분석 탭에 표시할 AI 요약을 작성합니다.
아래 수치만 근거로 분석하고, 없는 내용은 절대 추측하거나 지어내지 마세요.

[구매처 세그먼트 — 전월대비 증감]
${ctx.segments.map((s) => `- ${s.seg}: ${s.count}곳 (${s.deltaCount >= 0 ? "+" : ""}${s.deltaCount})`).join("\n")}

[신규 구매처]
- ${ctx.newBuyers.total}곳 (전월비 ${ctx.newBuyers.delta >= 0 ? "+" : ""}${ctx.newBuyers.delta})

위 도구(submit_buyer_analysis_summary)를 호출해서 결과를 제출하세요.
- churnRisk: 이탈위험 세그먼트 수치를 근거로 리스크 정도와 권장 조치를 한 문장으로.
- actionRecommendation: 관심/단발 세그먼트나 신규 구매처 현황을 근거로 실행 제안을 한 문장으로.`;
}

async function callClaudeForBuyerAnalysis(ctx) {
  const anthropic = getClient();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [BUYER_ANALYSIS_TOOL],
    tool_choice: { type: "tool", name: BUYER_ANALYSIS_TOOL.name },
    messages: [{ role: "user", content: buildBuyerAnalysisPrompt(ctx) }],
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse) throw new Error("Claude 응답에서 결과를 찾지 못했습니다.");

  const input = toolUse.input || {};
  const sanitizeCard = (card) => ({ hasData: Boolean(card && card.hasData), body: sanitizeText(card && card.body) });

  return {
    churnRisk: sanitizeCard(input.churnRisk),
    funnelBottleneck: FUNNEL_NO_DATA_CARD,
    actionRecommendation: sanitizeCard(input.actionRecommendation),
  };
}

function buyerAnalysisCacheKeyFor(filters) {
  const channelsKey = filters.channels && filters.channels.length ? filters.channels.slice().sort().join(",") : "all";
  return `buyerAnalysisSummary:${filters.company || "all"}:${filters.product || "all"}:${filters.region || "all"}:${filters.dept || "all"}:${channelsKey}:${filters.month || "current"}`;
}

function getBuyerAnalysisAiSummary(filters = {}) {
  return getOrSet(buyerAnalysisCacheKeyFor(filters), AI_SUMMARY_TTL, async () => {
    const ctx = await buildBuyerAnalysisContext(filters);
    return callClaudeForBuyerAnalysis(ctx);
  });
}

module.exports = { getDashboardAiSummary, getAiInsightTab, getBuyerAnalysisAiSummary };
