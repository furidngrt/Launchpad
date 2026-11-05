// Compiles every contract under src/ (and test/ when asked) with the solc
// bundled as an npm dependency, so a build needs no downloaded binary.
//
//   node tools/compile.mjs            # src only
//   node tools/compile.mjs --tests    # src + test
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const root = path.resolve(import.meta.dirname, "..");
const withTests = process.argv.includes("--tests");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".sol")) out.push(path.relative(root, full));
  }
  return out;
}

const sources = {};
const files = [...walk(path.join(root, "src")), ...(withTests ? walk(path.join(root, "test")) : [])];
for (const file of files) {
  sources[file] = { content: fs.readFileSync(path.join(root, file), "utf8") };
}

function resolve(importPath) {
  const candidates = [
    path.join(root, importPath),
    path.join(root, "node_modules", importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `not found: ${importPath}` };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolve }));

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
const warnings = (output.errors ?? []).filter((e) => e.severity !== "error");

for (const warning of warnings) {
  if (/SPDX|Unused|unused/.test(warning.formattedMessage)) continue;
  console.error(warning.formattedMessage);
}
for (const error of errors) console.error(error.formattedMessage);

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s)`);
  process.exit(1);
}

const outDir = path.join(root, "out");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const LIMIT = 24576;
const report = [];
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [name, artifact] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join(outDir, `${name}.json`),
      JSON.stringify({ abi: artifact.abi, bytecode: artifact.evm.bytecode.object }),
    );
    const size = (artifact.evm.deployedBytecode.object?.length ?? 0) / 2;
    if (size > 0 && file.startsWith("src/")) report.push({ name, size });
  }
}

report.sort((a, b) => b.size - a.size);
console.log("compiled:", report.length, "contracts with runtime code\n");
console.log("deployed size      bytes   of limit");
for (const { name, size } of report) {
  const flag = size > LIMIT ? "  OVER LIMIT" : "";
  console.log(`${name.padEnd(18)} ${String(size).padStart(6)}   ${((size / LIMIT) * 100).toFixed(1)}%${flag}`);
}

if (report.some((r) => r.size > LIMIT)) {
  console.error("\na contract exceeds the 24576-byte deployed-code limit");
  process.exit(1);
}
