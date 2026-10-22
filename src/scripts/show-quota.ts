#!/usr/bin/env bun
import { fetchQuotaData, formatQuotaCard } from "../utils/quota-formatter";

async function main() {
  const isTTY = Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined);
  const data = await fetchQuotaData();
  const card = formatQuotaCard(data, { ansiColor: isTTY });
  console.log("\n" + card + "\n");
}

main().catch(console.error);
