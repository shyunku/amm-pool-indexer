import { ParsedMessage, PublicKey } from "@solana/web3.js";

export function toPubkeyArray(msg: ParsedMessage): PublicKey[] {
  // legacy | v0 모두 string → PublicKey
  return msg.accountKeys.map(
    (k: any) => new PublicKey(typeof k === "string" ? k : k.pubkey)
  );
}

export function indexOfKey(keys: PublicKey[], target: PublicKey): number {
  return keys.findIndex((k) => k.equals(target));
}
