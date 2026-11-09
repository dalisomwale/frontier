// Asks Lipila for a payment's status and prints its full answer.
//
//   npm run lipila:status FMC-1011-1
//   npm run lipila:status FMC-1011-1 <Lipila identifier>
//
// Without a reference it lists the latest Lipila payments on the website.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const pool = require("../server/db");
const lipila = require("../server/services/lipila");

async function ask(query) {
  const res = await fetch(`${lipila.baseUrl()}/collections/check-status?${query}`, {
    headers: { accept: "application/json", "x-api-key": (process.env.LIPILA_API_KEY || "").trim() },
  });
  console.log(`\nGET /collections/check-status?${query}\n  HTTP ${res.status}\n  ${(await res.text()).slice(0, 1500)}`);
}

(async () => {
  if (!lipila.enabled()) throw new Error("LIPILA_API_KEY is not set in .env");
  console.log(`Lipila: ${lipila.baseUrl()}`);
  const [reference, identifier] = process.argv.slice(2);
  if (!reference) {
    const [rows] = await pool.query(
      `SELECT id, payment_reference, payment_provider_ref, payment_method, payment_status, total, created_at
       FROM checkouts WHERE payment_provider = 'lipila' ORDER BY id DESC LIMIT 10`,
    );
    console.log("\nLatest Lipila payments (reference, Lipila identifier, method, status, total):");
    for (const r of rows) console.log(`  ${r.payment_reference}  ${r.payment_provider_ref || "-"}  ${r.payment_method}  ${r.payment_status}  K ${r.total}`);
    console.log("\nCheck one with: npm run lipila:status <reference> [identifier]");
  } else {
    let ident = identifier;
    if (!ident) {
      const [[row]] = await pool.query("SELECT payment_provider_ref FROM checkouts WHERE payment_reference = ?", [reference]);
      ident = row && row.payment_provider_ref;
    }
    await ask(`referenceId=${encodeURIComponent(reference)}`);
    if (ident) await ask(`identifier=${encodeURIComponent(ident)}`);
  }
  await pool.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
