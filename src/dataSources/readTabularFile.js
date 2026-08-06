const fs = require("fs");
const path = require("path");
const readXlsxFile = require("read-excel-file/node");
const { parse: parseCsv } = require("csv-parse/sync");

// 헤더 행 + 값 행 배열을 [{header: value}] 형태로 변환
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h ?? "").trim());
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      if (!header) return;
      obj[header] = row[i] ?? null;
    });
    return obj;
  });
}

async function readXlsx(filePath) {
  const rows = await readXlsxFile(filePath);
  return rowsToObjects(rows);
}

function readCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(content);
  if (Array.isArray(data)) return data;
  throw new Error(`${filePath}: JSON 최상위는 배열이어야 합니다`);
}

// 파일 확장자에 따라 xlsx/csv/json을 읽어 [{원본헤더: 값}] 배열로 반환
async function readTabularFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".xlsx":
      return readXlsx(filePath);
    case ".csv":
      return readCsv(filePath);
    case ".json":
      return readJson(filePath);
    default:
      throw new Error(`지원하지 않는 파일 형식: ${ext} (${filePath})`);
  }
}

module.exports = { readTabularFile };
