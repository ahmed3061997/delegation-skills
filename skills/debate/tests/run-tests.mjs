#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collected } from "../../delegate/tests/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? null;
const suites = readdirSync(here)
  .filter((name) => name.endsWith(".test.mjs"))
  .filter((name) => !filter || name.includes(filter))
  .sort();
let passed = 0;
const failures = [];
for (const suite of suites) {
  await import(pathToFileURL(join(here, suite)).href);
  const cases = collected();
  process.stdout.write(`\n${suite}  (${cases.length})\n`);
  for (const testCase of cases) {
    try {
      await testCase.fn();
      passed += 1;
      process.stdout.write(`  ok    ${testCase.name}\n`);
    } catch (error) {
      failures.push({ suite, name: testCase.name, error });
      process.stdout.write(`  FAIL  ${testCase.name}\n`);
    }
  }
}
if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s):\n`);
  for (const failure of failures) process.stdout.write(`\n─ ${failure.suite} › ${failure.name}\n${failure.error?.stack ?? failure.error}\n`);
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
