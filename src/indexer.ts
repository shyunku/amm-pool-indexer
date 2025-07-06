import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  Keypair,
  PartiallyDecodedInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { TOKEN_SWAP_PROGRAM_ID } from "@solana/spl-token-swap";
import { decodeSwapInstruction } from "./utils/decodeSwap.js";
import { indexOfKey, toPubkeyArray } from "./utils/common.js";

// .env 파일의 환경 변수를 process.env로 로드합니다.
dotenv.config();

// --- 설정 (환경 변수에서 로드) ---
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
const SWAP_ACCOUNT_KEY_PATH = process.env.SWAP_ACCOUNT_KEY_PATH;
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || "5000");

// 필수 환경 변수 확인
if (!SWAP_ACCOUNT_KEY_PATH) {
  throw new Error(
    "오류: .env 파일에 KEY_DIR 또는 SWAP_ACCOUNT_KEY_PATH이 설정되지 않았습니다."
  );
}

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
export const chartData: SwapData[] = [];

// --- 헬퍼 함수 ---
function readAddressFromFile(filepath: string): string {
  try {
    return fs.readFileSync(filepath, { encoding: "utf8" }).trim();
  } catch (e) {
    console.error(
      `오류: ${filepath} 파일을 읽을 수 없습니다. KEY_DIR 경로를 확인하세요.`,
      e
    );
    process.exit(1);
  }
}

function diffAmount(
  before: { uiTokenAmount: { amount: string } } | undefined,
  after: { uiTokenAmount: { amount: string } } | undefined
) {
  const a = after ? BigInt(after.uiTokenAmount.amount) : 0n;
  const b = before ? BigInt(before.uiTokenAmount.amount) : 0n;
  return a - b; // BigInt 양·음수
}

// --- 메인 인덱서 로직 ---
export async function runIndexer() {
  const connection = new Connection(RPC_URL!, "confirmed");

  if (!SWAP_ACCOUNT_KEY_PATH) {
    throw new Error(`swap account key path not provided`);
  }

  const keypairFile = JSON.parse(readAddressFromFile(SWAP_ACCOUNT_KEY_PATH));
  const swapAccountAddress = Keypair.fromSecretKey(
    Uint8Array.from(keypairFile)
  ).publicKey;

  let lastKnownSignature: string | undefined = undefined;

  console.log(`🚀 미니 인덱서 시작. 풀 주소: ${swapAccountAddress.toBase58()}`);
  console.log(`🔍 ${POLLING_INTERVAL_MS / 1000}초마다 새 거래를 확인합니다...`);

  const DECIMALS = 9n;
  const toFloat = (x: bigint) => Number(x) / 10 ** Number(DECIMALS);

  setInterval(async () => {
    try {
      const signatures = await connection.getSignaturesForAddress(
        swapAccountAddress,
        {
          until: lastKnownSignature,
          limit: 40,
        }
      );

      if (signatures.length === 0) return;
      console.log("[DEBUG] 새 서명:", signatures.length);

      lastKnownSignature = signatures[0].signature;
      const transactions = await connection.getParsedTransactions(
        signatures.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );

      for (const tx of transactions.reverse()) {
        if (!tx) continue;

        const pre = tx.meta?.preTokenBalances ?? [];
        const post = tx.meta?.postTokenBalances ?? [];
        if (!pre.length || !post.length) continue; // 토큰 변화 없는 TX

        /* ── 메시지 accountKey 배열을 PublicKey[] 로 정규화 ── */
        const msgKeys = toPubkeyArray(tx.transaction.message as any);

        /* ── 이 TX 안의 spl-token-swap 인스트럭션들 ── */
        const swaps = tx.transaction.message.instructions.filter((i) =>
          i.programId.equals(TOKEN_SWAP_PROGRAM_ID)
        ) as PartiallyDecodedInstruction[];

        for (const inst of swaps) {
          /* ① Swap 태그 확인 */
          if (!decodeSwapInstruction(inst.data)) continue;

          /* ② userSource / Destination 인덱스 찾기 */
          const userSrcIdx = indexOfKey(msgKeys, inst.accounts[3]); // userSource
          const userDstIdx = indexOfKey(msgKeys, inst.accounts[6]); // userDestination
          if (userSrcIdx < 0 || userDstIdx < 0) continue; // 방어

          /* ③ balance diff (BigInt) */
          const preSrc = pre.find((b) => b.accountIndex === userSrcIdx);
          const postSrc = post.find((b) => b.accountIndex === userSrcIdx);
          const preDst = pre.find((b) => b.accountIndex === userDstIdx);
          const postDst = post.find((b) => b.accountIndex === userDstIdx);
          if (!preSrc || !postSrc || !preDst || !postDst) continue;

          const inΔ = diffAmount(preSrc, postSrc); // 음수
          const outΔ = diffAmount(preDst, postDst); // 양수
          if (inΔ >= 0n || outΔ <= 0n) continue; // 스왑 아님

          /* ④ chartData push */
          const amountIn = -inΔ;
          const amountOut = outΔ;
          const price = toFloat(amountOut) / toFloat(amountIn);
          chartData.push({
            timestamp: tx.blockTime!,
            signature: tx.transaction.signatures[0],
            swappedFrom: preSrc.mint,
            swappedTo: preDst.mint,
            amountIn: toFloat(amountIn),
            amountOut: toFloat(amountOut),
            price,
          });

          console.log(
            `✅ [${new Date(tx.blockTime! * 1000).toLocaleTimeString()}] ` +
              `스왑: ${toFloat(amountIn)} → ${toFloat(
                amountOut
              )}, price: ${price}`
          );
        }
      }
    } catch (error) {
      // console.error("인덱싱 오류:", error); // 필요 시 주석 해제
    }
  }, POLLING_INTERVAL_MS);
}
