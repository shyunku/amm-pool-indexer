import { ParsedMessage, PublicKey } from "@solana/web3.js";
import path from "path";
import * as fs from "fs";

export function toPubkeyArray(msg: ParsedMessage): PublicKey[] {
  // legacy | v0 모두 string → PublicKey
  return msg.accountKeys.map(
    (k: any) => new PublicKey(typeof k === "string" ? k : k.pubkey)
  );
}

export function indexOfKey(keys: PublicKey[], target: PublicKey): number {
  return keys.findIndex((k) => k.equals(target));
}

export function readAddressFromFile(filepath: string): string {
  const fullPath = path.resolve(filepath);
  return fs.readFileSync(fullPath, { encoding: "utf8" }).trim();
}
