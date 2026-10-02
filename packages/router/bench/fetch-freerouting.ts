#!/usr/bin/env bun
/** Download pinned Freerouting and (with --jdk) Temurin Java 25. */
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { VENDOR_DIR } from "../src/freerouting";
import { fetchFreerouting } from "../src/freerouting-runtime";

const target = process.argv.find((arg) => arg.startsWith("--target="))?.slice(9) ?? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const withJdk = process.argv.includes("--jdk");
const runtime = await fetchFreerouting(VENDOR_DIR, target, withJdk);
if (withJdk) {
  const destination = target.startsWith("darwin") ? join(VENDOR_DIR, "jdk", "Contents", "Home") : join(VENDOR_DIR, "jdk");
  await cp(runtime.jdkHome, destination, { recursive: true });
}
console.log(JSON.stringify(runtime));
