const { CRAWLERS } = require("../crawlers");

function parseArg(flag) {
  const flagIndex = process.argv.indexOf(flag);
  return flagIndex === -1 ? null : process.argv[flagIndex + 1];
}

function parseArgs() {
  const job = parseArg("--job");
  if (!job) {
    throw new Error('Usage: node src/jobs/runCrawl.js --job <name> [--data \'{"key":"value"}\']');
  }
  const dataArg = parseArg("--data");
  const params = dataArg ? JSON.parse(dataArg) : {};
  return { job, params };
}

async function main() {
  const { job, params } = parseArgs();
  const CrawlerClass = CRAWLERS[job];
  if (!CrawlerClass) {
    throw new Error(`Unknown job "${job}". Available: ${Object.keys(CRAWLERS).join(", ")}`);
  }

  console.log(`[${new Date().toISOString()}] starting job=${job} params=${JSON.stringify(params)}`);
  const rows = await new CrawlerClass(params).run();
  console.log(`[${new Date().toISOString()}] finished job=${job}`);
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
