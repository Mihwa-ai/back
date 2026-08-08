const Anthropic = require("@anthropic-ai/sdk");
const config = require("../config");
const { getOrSet } = require("./cache");
const { getKpiTrend, getRegionSales, getDeptSales, getBuyerSegments } = require("./dashboardQueries");

const AI_SUMMARY_TTL = 6 * 60 * 60 * 1000; // PRD의 "매일 새벽 03:00 갱신"을 단순화한 캐시 주기
const MODEL = "claude-sonnet-5";

const SUMMARY_TOOL = {
  name: "submit_dashboard_summary",
  description: "대시보드 AI 인사이트 결과를 제출한다",
  input_schema: {
    type: "object",
    properties: {
      top3: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
        description: "공통 필터 영역 상단에 표시할 핵심 인사이트 3개 — 성장 요인/리스크/추천 실행과제 순으로 각 1문장, 반드시 수치를 포함",
      },
      summary: {
        type: "string",
        description: "매출 대시보드 탭 하단 '대시보드 분석 요약' 카드에 표시할 3줄 요약. 줄바꿈(\\n)으로 구분된 3문장 — 핵심 변화 원인 → 리스크/기회 → 다음 액션 순서",
      },
    },
    required: ["top3", "summary"],
  },
};

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
    getKpiTrend({ ...filters, months: 2 }),
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
  return toolUse.input;
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

module.exports = { getDashboardAiSummary };
