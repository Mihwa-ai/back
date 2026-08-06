const axios = require("axios");
const { Crawler } = require("./base");

const ENDPOINT = "https://biz.kpis.or.kr/main/sk/skt/selectMSUPCDList.ndo";

// 페이지네이션 메타 필드라 저장 대상에서 제외
const META_FIELDS = new Set(["rn", "totCnt", "totalPages"]);

function toSnakeCase(key) {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function normalizeRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (META_FIELDS.has(key)) continue;
    normalized[toSnakeCase(key)] = value;
  }
  normalized.crawled_at = new Date().toISOString();
  return normalized;
}

class KpisStdCodeCrawler extends Crawler {
  table = "kpis_std_codes";

  async fetch() {
    const { sStdCd = "" } = this.params;
    const { data } = await axios.post(
      ENDPOINT,
      {
        dmParam: {
          sEntpCd: "",
          sItemStdCd: "",
          sStdCd,
          sMgdsCd: "",
          sMgdsCd3: "",
          sEntpNm: "",
          sItemNm: "",
          sMgdsNm: "",
          sAtc: "",
          recordsTotal: "0",
          pageIndexerCount: "5",
          recordCountPerPage: "10",
          currentPageNo: "1",
          resentSplyDstbDesc: "",
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );
    return data;
  }

  async parse(raw) {
    const list = raw?.dsMSUPCDList ?? [];
    return list.map(normalizeRow);
  }
}

module.exports = { KpisStdCodeCrawler };
