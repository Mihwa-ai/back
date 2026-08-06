const { getSupabase } = require("../supabaseClient");

class Crawler {
  table = null;

  constructor(params = {}) {
    this.params = params;
  }

  async fetch() {
    throw new Error("fetch() not implemented");
  }

  async parse(_raw) {
    throw new Error("parse() not implemented");
  }

  async save(rows) {
    if (!this.table) return; // no table assigned yet: verify-only crawler
    if (!rows.length) return;
    const { error } = await getSupabase().from(this.table).upsert(rows);
    if (error) throw error;
  }

  async run() {
    const raw = await this.fetch();
    const rows = await this.parse(raw);
    await this.save(rows);
    return rows;
  }
}

module.exports = { Crawler };
