// src/utils/decodeSwap.ts
import bs58 from "bs58";
import { Buffer } from "buffer";

export interface DecodedSwap {
  amountIn: bigint;
  minAmountOut: bigint;
}

export function decodeSwapInstruction(dataB58: string): DecodedSwap | null {
  const buf = Buffer.from(bs58.decode(dataB58)); // Buffer 로 변환
  if (buf.length < 17 || buf[0] !== 1) return null; // tag 1 = Swap
  const amountIn = buf.readBigUInt64LE(1);
  const minAmountOut = buf.readBigUInt64LE(9);
  return { amountIn, minAmountOut };
}
