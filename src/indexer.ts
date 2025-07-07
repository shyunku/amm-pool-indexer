// src/indexer.ts (polling 부분 싹 제거하고 교체)

import {
  Connection,
  PublicKey,
  Keypair,
  PartiallyDecodedInstruction,
  LogsCallback,
} from "@solana/web3.js";
import { TOKEN_SWAP_PROGRAM_ID } from "@solana/spl-token-swap";
import { decodeSwapInstruction } from "./utils/decodeSwap.js";
import { indexOfKey, toPubkeyArray } from "./utils/common.js";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

// --- 데이터 저장소 ---
interface SwapData {
  timestamp: number;
  signature: string;
  swappedFrom: string;
  swappedTo: string;
  amountIn: number;
  amountOut: number;
  price: number;
}

/* ---------- 설정 ---------- */
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
const SWAP_ACCOUNT_KEY_PATH = process.env.SWAP_ACCOUNT_KEY_PATH;
if (!SWAP_ACCOUNT_KEY_PATH) throw new Error("SWAP_ACCOUNT_KEY_PATH 누락");

const connection = new Connection(RPC_URL, "confirmed");
const swapAccountPk = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(SWAP_ACCOUNT_KEY_PATH, "utf8")))
).publicKey;

console.log("🚀 WebSocket 인덱서 시작 – 풀:", swapAccountPk.toBase58());

/* ---------- 유틸 ---------- */
const DECIMALS = 9n;
const toFloat = (x: bigint) => Number(x) / 10 ** Number(DECIMALS);
const diffAmount = (bef?: any, aft?: any) =>
  (aft ? BigInt(aft.uiTokenAmount.amount) : 0n) -
  (bef ? BigInt(bef.uiTokenAmount.amount) : 0n);

/* ---------- 중복 방지용 Set ---------- */
const seen = new Set<string>();

/* ---------- Savings ---------- */
export const chartData: SwapData[] = [];
let lastSavedSignature: string | null = null;

async function backfill(fromSig: string | null) {
  let before: string | undefined = undefined;
  while (true) {
    const sigs = await connection.getSignaturesForAddress(swapAccountPk, {
      before,
      until: fromSig ?? undefined,
      limit: 1_000,
    });
    if (!sigs.length) break;

    for (const s of sigs.reverse()) {
      // 오래된 → 최신
      await handleTx(s.signature, s.slot);
    }
    before = sigs[0].signature; // 직전 batch 중 가장 옛것
  }
}

/**
 * handleTx
 * --------
 * • signature           : 트랜잭션 서명
 * • connection (global) : @solana/web3.js Connection 객체
 * • TOKEN_SWAP_PROGRAM_ID, chartData, seen, toFloat, diffAmount, etc. 는
 *   파일 상단에서 import/정의돼 있다고 가정
 */
export async function handleTx(
  signature: string,
  slot?: number
): Promise<void> {
  // 0. 중복 방지
  if (seen.has(signature)) return;
  seen.add(signature);

  // 1. 트랜잭션 전문 조회
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return; // 블록 타이밍에 따라 null 가능

  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  if (!pre.length || !post.length) return; // 토큰 변화 없는 트xn

  // 2. 메시지의 accountKey 배열(PublicKey[]) 정규화
  const msgKeys = toPubkeyArray(tx.transaction.message as any);

  // 3. swap 프로그램 인스트럭션 필터링
  const swaps = tx.transaction.message.instructions.filter((i) =>
    i.programId.equals(TOKEN_SWAP_PROGRAM_ID)
  ) as PartiallyDecodedInstruction[];
  if (!swaps.length) return;

  for (const inst of swaps) {
    // 3-1. 태그 1(Swap)인지 확인
    if (!decodeSwapInstruction(inst.data)) continue;

    // 3-2. userSource(3), userDestination(6) 인덱스 계산
    const srcIdx = indexOfKey(msgKeys, inst.accounts[3]);
    const dstIdx = indexOfKey(msgKeys, inst.accounts[6]);
    if (srcIdx < 0 || dstIdx < 0) continue;

    // 3-3. pre/post balance 가져오기
    const preSrc = pre.find((b) => b.accountIndex === srcIdx);
    const postSrc = post.find((b) => b.accountIndex === srcIdx);
    const preDst = pre.find((b) => b.accountIndex === dstIdx);
    const postDst = post.find((b) => b.accountIndex === dstIdx);
    if (!preSrc || !postSrc || !preDst || !postDst) continue;

    // 3-4. 변화량 계산 (BigInt)
    const inΔ = diffAmount(preSrc, postSrc); // 음수
    const outΔ = diffAmount(preDst, postDst); // 양수
    if (inΔ >= 0n || outΔ <= 0n) continue; // 스왑 아님

    // 3-5. 기록 & 로그
    const amountIn = -inΔ;
    const amountOut = outΔ;
    const price = toFloat(amountOut) / toFloat(amountIn);

    const timestamp = tx.blockTime ?? Math.floor(Date.now() / 1e3);
    chartData.push({
      timestamp, // Unix epoch (s)
      signature: signature,
      swappedFrom: preSrc.mint,
      swappedTo: preDst.mint,
      amountIn: toFloat(amountIn),
      amountOut: toFloat(amountOut),
      price,
    });

    console.log(
      `✅ [${new Date(tx.blockTime! * 1000).toLocaleTimeString()}]` +
        ` 스왑: ${toFloat(amountIn)} → ${toFloat(amountOut)}, price ${price}`
    );
  }

  // 4. seen Set 트리밍 (메모리 누수 방지)
  if (seen.size > 10_000) {
    for (const sig of seen.values()) {
      if (seen.size <= 5_000) break;
      seen.delete(sig);
    }
  }

  // 5. 마지막 처리 서명 갱신(백필용)
  lastSavedSignature = signature;
}

export async function runIndexer() {
  /* 1️⃣ 부팅 시 백필 */
  await backfill(lastSavedSignature);

  /* 2️⃣ 실시간 구독 */
  connection.onLogs(
    TOKEN_SWAP_PROGRAM_ID,
    async (l, ctx) => {
      await handleTx(l.signature, ctx.slot);
    },
    "confirmed"
  );

  /* --------------- WebSocket 재연결 감지 --------------- */
  const rpcWs: any = (connection as any)._rpcWebSocket;

  /* a) 끊겼을 때 */
  rpcWs.on("close", () => {
    console.warn("⚠️  WebSocket disconnected. Will backfill on reconnect.");
  });

  /* b) 다시 붙었을 때 */
  rpcWs.on("open", async () => {
    console.log("🔄  WebSocket re-connected. Running backfill…");
    await backfill(lastSavedSignature);
  });
}
