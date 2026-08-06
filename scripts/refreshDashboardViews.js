const { getSupabase } = require("../src/supabaseClient");

async function main() {
  const supabase = getSupabase();
  console.log(`[${new Date().toISOString()}] refreshing dream_vendor_product_first_sale...`);
  const { error } = await supabase.rpc("refresh_dashboard_first_sale_view");
  if (error) throw new Error(error.message);
  console.log(`[${new Date().toISOString()}] done`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
