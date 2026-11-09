// Card check against Lipila, without a website order:
//
//   npm run lipila:card-test you@example.com 0977123456
//
// Asks Lipila to create a K 1 card payment page and prints its full answer,
// the page address, and whether the page can open inside the checkout.
// Nothing is charged unless someone opens the page and pays.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const lipila = require("../server/services/lipila");

(async () => {
  if (!lipila.enabled()) throw new Error("LIPILA_API_KEY is not set in .env");
  const [email, phone] = process.argv.slice(2);
  if (!email || !phone) throw new Error("Usage: npm run lipila:card-test <email> <phone>");
  const site = (process.env.APP_URL || "https://marketplace.frontierfc.co.zm").replace(/\/+$/, "");
  const reference = `FRONTIER-CARDTEST-${Date.now()}`;
  console.log(`Lipila: ${lipila.baseUrl()}`);
  console.log(`Cards switched on for the website (LIPILA_CARDS): ${lipila.cardsEnabled() ? "yes" : "no"}`);
  const body = lipila.cardBody({
    reference,
    amount: 1,
    phone,
    email,
    narration: "Frontier Marketplace card test",
    customer: { name: "Card Test", city: "Lusaka", address: "Piziya Office Park, Thabo Mbeki Road" },
    backUrl: `${site}/`,
  });
  const res = await fetch(`${lipila.baseUrl()}/collections/card`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-api-key": (process.env.LIPILA_API_KEY || "").trim() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\nPOST /collections/card (${reference}, K 1)\n  HTTP ${res.status}\n  ${text.slice(0, 1500)}`);
  let data = {};
  try { data = JSON.parse(text); } catch {}
  const url = data.cardRedirectionUrl || (data.data && data.data.cardRedirectionUrl);
  if (!url) {
    console.log("\nNo card page address in the answer: cards may not be switched on for this Lipila account yet.");
    return;
  }
  console.log(`\nCard page: ${url}`);
  const embed = await lipila.canEmbed(url, new URL(site).origin);
  console.log(`Can open inside the checkout page: ${embed ? "yes" : "no (buyers will be sent to Lipila's page and back)"}`);
  console.log(`\nCheck its status with: npm run lipila:status ${reference}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
