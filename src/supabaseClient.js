const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require("./config");

let client;

function getSupabase() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}

module.exports = { getSupabase };
