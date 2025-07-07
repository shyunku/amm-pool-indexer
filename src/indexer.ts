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
import {
  indexOfKey,
  readAddressFromFile,
  toPubkeyArray,
} from "./utils/common.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import path from "path";
import type { Database as SqliteDB } from "better-sqlite3";
import Database from "better-sqlite3";

dotenv.config();

// --- 데이터 저장소 ---
interface SwapData {
  timestamp: number;
  signature: string;
  swappedFrom: string;
  swappedTo: string;
  amountBase: number;
  amountQuote: number;
  amountIn: number;
  amountOut: number;
  price: number;
  poolPrice: number;
}

/* ---------- 설정 ---------- */
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";

const connection = new Connection(RPC_URL, "confirmed");
let swapAccountPk!: PublicKey;
let mintAAddress!: PublicKey;
let mintBAddress!: PublicKey;
let decimalsA!: number;
let decimalsB!: number;
let scaleA!: number; // 10 ** decimalsA
let scaleB!: number; // 10 ** decimalsB

/* ---------- ⬇ 추가: vault 계정 주소 ---------- */
let vaultAAddress!: PublicKey;
let vaultBAddress!: PublicKey;

/* ---------- 유틸 ---------- */
const toFloatA = (x: bigint) => Number(x) / scaleA; // Apple
const toFloatB = (x: bigint) => Number(x) / scaleB; // Banana
const diffAmount = (bef?: any, aft?: any) =>
  (aft ? BigInt(aft.uiTokenAmount.amount) : 0n) -
  (bef ? BigInt(bef.uiTokenAmount.amount) : 0n);

/* ---------- 중복 방지용 Set ---------- */
const seen = new Set<string>();

/* ---------- Savings ---------- */
export const chartData: SwapData[] = [];
let lastSavedSignature: string | null = null;

let db!: SqliteDB; // ★ DB 핸들
let lastFlushed = 0; // ★ 마지막 commit 된 chartData.length

/** 새 row들만 INSERT */
function flushToDB() {
  if (!db || chartData.length === lastFlushed) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO swap_data
    (timestamp,signature,swappedFrom,swappedTo,
     amountBase,amountQuote,amountIn,amountOut,
     price,poolPrice)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  db.transaction(() => {
    for (let i = lastFlushed; i < chartData.length; i++) {
      const c = chartData[i];
      insert.run(
        c.timestamp,
        c.signature,
        c.swappedFrom,
        c.swappedTo,
        c.amountBase,
        c.amountQuote,
        c.amountIn,
        c.amountOut,
        c.price,
        c.poolPrice
      );
    }
  })();
  lastFlushed = chartData.length;
}

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

    const srcMintStr = preSrc.mint;
    const baseIsApple = new PublicKey(srcMintStr).equals(mintAAddress);

    /* ---------- 교체: 풀 잔고 기준 가격 ---------- */
    // a) vault 계정 index 찾기
    const vAIdx = indexOfKey(msgKeys, vaultAAddress);
    const vBIdx = indexOfKey(msgKeys, vaultBAddress);
    if (vAIdx < 0 || vBIdx < 0) continue;

    // b) 스왑 직후 vault 잔고(postTokenBalances) 추출
    const postVA = post.find((b) => b.accountIndex === vAIdx);
    const postVB = post.find((b) => b.accountIndex === vBIdx);
    if (!postVA || !postVB) continue;

    const reserveA = BigInt(postVA.uiTokenAmount.amount); // Apple lamports
    const reserveB = BigInt(postVB.uiTokenAmount.amount); // Banana lamports

    // c) Apple-기준 가격
    const poolPrice = toFloatB(reserveB) / toFloatA(reserveA);

    // d) 기존 amountBase/Quote는 그대로 유지(원하면 삭제)
    const amountBase = baseIsApple ? amountIn : amountOut;
    const amountQuote = baseIsApple ? amountOut : amountIn;
    const price = toFloatB(amountQuote) / toFloatA(amountBase);

    const absAmountIn = baseIsApple ? toFloatA(amountIn) : toFloatB(amountIn);
    const absAmountOut = baseIsApple
      ? toFloatA(amountOut)
      : toFloatB(amountOut);

    const timestamp = tx.blockTime ?? Date.now() / 1e3;
    chartData.push({
      timestamp, // Unix epoch (s)
      signature: signature,
      swappedFrom: preSrc.mint,
      swappedTo: preDst.mint,
      amountBase: toFloatA(amountBase), // Apple
      amountQuote: toFloatB(amountQuote), // Banana
      amountIn: absAmountIn,
      amountOut: absAmountOut,
      price,
      poolPrice,
    });

    console.log(
      `✅ [${new Date(tx.blockTime! * 1000).toLocaleTimeString()}]` +
        ` 스왑: ${absAmountIn} → ${absAmountOut}, price ${price}`
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
  /* ---------- CLI 옵션 파싱 ---------- */
  const argv = await yargs(hideBin(process.argv))
    .option("key-dir", {
      alias: "k",
      type: "string",
      description: "AMM 풀 키/주소 파일이 저장된 디렉토리 경로",
      demandOption: true,
    })
    .strict()
    .parse();

  const keyDirPath = argv.keyDir;
  const swapAccountKeyPairPath = path.resolve(keyDirPath, "swap_account.json");

  mintAAddress = new PublicKey(
    readAddressFromFile(`${argv.keyDir}/mint_a.txt`)
  );
  mintBAddress = new PublicKey(
    readAddressFromFile(`${argv.keyDir}/mint_b.txt`)
  );
  vaultAAddress = new PublicKey(
    readAddressFromFile(`${keyDirPath}/vault_a.txt`)
  );
  vaultBAddress = new PublicKey(
    readAddressFromFile(`${keyDirPath}/vault_b.txt`)
  );

  swapAccountPk = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(swapAccountKeyPairPath, "utf8")))
  ).publicKey;

  const getMintDecimals = async (mint: PublicKey) => {
    const info = await connection.getParsedAccountInfo(mint);
    if (!info.value) throw new Error(`cannot fetch mint ${mint.toBase58()}`);
    return (info.value.data as any).parsed.info.decimals as number;
  };
  decimalsA = await getMintDecimals(mintAAddress);
  decimalsB = await getMintDecimals(mintBAddress);
  scaleA = 10 ** decimalsA;
  scaleB = 10 ** decimalsB;
  console.log(
    `🍎 Apple(decimals=${decimalsA})  🍌 Banana(decimals=${decimalsB})\n` +
      `vaultA=${vaultAAddress.toBase58()}  vaultB=${vaultBAddress.toBase58()}`
  );

  console.log(
    "🚀 WebSocket 인덱서 시작 - Swap Account Pubkey:",
    swapAccountPk.toBase58()
  );

  /* ---------- SQLite 초기화 ---------- */
  const DB_PATH = path.resolve(keyDirPath, "cache.db");
  db = new Database(DB_PATH);
  db.exec(`
  CREATE TABLE IF NOT EXISTS swap_data (
    timestamp  INTEGER,
    signature  TEXT PRIMARY KEY,
    swappedFrom TEXT,
    swappedTo   TEXT,
    amountBase  REAL,
    amountQuote REAL,
    amountIn    REAL,
    amountOut   REAL,
    price       REAL,
    poolPrice   REAL
  );
`);

  /* 1) 기존 데이터 메모리로 로드 */
  const rows: any = db
    .prepare("SELECT * FROM swap_data ORDER BY timestamp ASC")
    .all();
  for (const r of rows) {
    chartData.push(r as SwapData);
    seen.add(r.signature);
  }
  lastFlushed = chartData.length;
  if (rows.length) lastSavedSignature = rows[rows.length - 1].signature;
  console.log(`💾 ${rows.length} rows restored from ${DB_PATH}`);

  /* 1️⃣ 부팅 시 백필 */
  await backfill(lastSavedSignature);

  /* 2️⃣ 5초마다 SQLite로 flush */
  setInterval(flushToDB, 5000);

  /* 종료 시 마지막 flush */
  const graceful = () => {
    flushToDB();
    process.exit();
  };
  process.on("SIGINT", graceful);
  process.on("SIGTERM", graceful);

  /* 실시간 구독 */
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
    console.log("🔄  WebSocket connected. Running backfill…");
    await backfill(lastSavedSignature);
  });
}
