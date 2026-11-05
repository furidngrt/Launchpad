// Submits every contract in a deployment record for source verification on an
// Etherscan-family explorer, using the exact compiler input the build wrote.
//
//   NETWORK=sepolia ETHERSCAN_API_KEY=... node tools/verify.mjs
//
// Run "npm run build" first, from the same sources that were deployed.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const network = process.env.NETWORK ?? "sepolia";
const apiKey = process.env.ETHERSCAN_API_KEY;
if (!apiKey) throw new Error("set ETHERSCAN_API_KEY");

const deployment = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${network}.json`), "utf8"));
const input = fs.readFileSync(path.join(root, "out", "standard-input.json"), "utf8");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "out", "compiler.json"), "utf8"));
const compilerVersion = "v" + version.replace(/\.Emscripten.*$/, "");
const endpoint = `https://api.etherscan.io/v2/api?chainid=${deployment.chainId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apikey: apiKey, ...body }),
  });
  return response.json();
}

async function get(query) {
  const response = await fetch(`${endpoint}&${new URLSearchParams({ apikey: apiKey, ...query })}`);
  return response.json();
}

console.log(`verifying ${Object.keys(deployment.contracts).length} contracts on chain ${deployment.chainId} with ${compilerVersion}\n`);

let failures = 0;
for (const [name, entry] of Object.entries(deployment.contracts)) {
  const existing = await get({ module: "contract", action: "getsourcecode", address: entry.address });
  if (existing.status === "1" && existing.result?.[0]?.SourceCode) {
    console.log(`${name.padEnd(18)} already verified`);
    continue;
  }

  const submitted = await post({
    module: "contract",
    action: "verifysourcecode",
    contractaddress: entry.address,
    sourceCode: input,
    codeformat: "solidity-standard-json-input",
    contractname: entry.source,
    compilerversion: compilerVersion,
    constructorArguements: entry.constructorArgs.replace(/^0x/, ""),
  });
  if (submitted.status !== "1") {
    // The explorer may not have indexed a fresh contract yet.
    console.log(`${name.padEnd(18)} not submitted: ${submitted.result}`);
    failures++;
    continue;
  }

  let outcome = "pending";
  for (let attempt = 0; attempt < 30 && /pending|queue/i.test(outcome); attempt++) {
    await sleep(5000);
    const status = await get({ module: "contract", action: "checkverifystatus", guid: submitted.result });
    outcome = String(status.result);
  }
  const ok = /pass|already verified/i.test(outcome);
  if (!ok) failures++;
  console.log(`${name.padEnd(18)} ${outcome}`);
}

console.log(failures === 0 ? "\nall contracts verified" : `\n${failures} contract(s) not verified`);
process.exit(failures === 0 ? 0 : 1);
