// Template crawler. Copy this file for each real crawling target and
// register the new class in src/crawlers/index.js's CRAWLERS map.

const axios = require("axios");
const cheerio = require("cheerio");
const { Crawler } = require("./base");

class ExampleCrawler extends Crawler {
  table = "example_items";
  url = "https://example.com";

  async fetch() {
    const { data } = await axios.get(this.url, { timeout: 10000 });
    return data;
  }

  async parse(raw) {
    const $ = cheerio.load(raw);
    const title = $("title").first().text() || null;
    return [{ source_url: this.url, title }];
  }
}

module.exports = { ExampleCrawler };
