import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  Keypair,
} from "@solana/web3.js";
import * as fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

// .env 파일의 환경 변수를 process.env로 로드합니다.
dotenv.config();

// --- 설정 (환경 변수에서 로드) ---
const RPC_URL = process.env.RPC_URL;
const KEY_DIR = process.env.KEY_DIR;
const SWAP_ACCOUNT_KEY_PATH = process.env.SWAP_ACCOUNT_KEY_PATH;
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || "5000");

// 필수 환경 변수 확인
if (!RPC_URL || !KEY_DIR || !SWAP_ACCOUNT_KEY_PATH) {
  throw new Error(
    "오류: .env 파일에 RPC_URL 또는 KEY_DIR, SWAP_ACCOUNT_KEY_PATH이 설정되지 않았습니다."
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
function readAddressFromFile(filename: string): string {
  const fullPath = path.resolve(KEY_DIR!, filename); // KEY_DIR는 위에서 존재 여부를 확인했음
  try {
    return fs.readFileSync(fullPath, { encoding: "utf8" }).trim();
  } catch (e) {
    console.error(
      `오류: ${fullPath} 파일을 읽을 수 없습니다. KEY_DIR 경로를 확인하세요.`,
      e
    );
    process.exit(1);
  }
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

  setInterval(async () => {
    try {
      const signatures = await connection.getSignaturesForAddress(
        swapAccountAddress,
        {
          until: lastKnownSignature,
          limit: 20,
        }
      );

      if (signatures.length === 0) return;

      lastKnownSignature = signatures[0].signature;
      const transactions = await connection.getParsedTransactions(
        signatures.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );

      for (const tx of transactions.reverse()) {
        // 오래된 순서부터 처리
        if (!tx) continue;

        for (const inst of tx.transaction.message.instructions) {
          if ("parsed" in inst && inst.parsed?.type === "swap") {
            const swapInfo = inst.parsed.info;
            const preBalances =
              tx.meta?.preTokenBalances?.filter(
                (b) => b.owner === swapInfo.userTransferAuthority
              ) || [];
            const postBalances =
              tx.meta?.postTokenBalances?.filter(
                (b) => b.owner === swapInfo.userTransferAuthority
              ) || [];

            const tokenAChange =
              (postBalances.find((b) => b.mint === swapInfo.source)
                ?.uiTokenAmount.uiAmount || 0) -
              (preBalances.find((b) => b.mint === swapInfo.source)
                ?.uiTokenAmount.uiAmount || 0);
            const tokenBChange =
              (postBalances.find((b) => b.mint === swapInfo.destination)
                ?.uiTokenAmount.uiAmount || 0) -
              (preBalances.find((b) => b.mint === swapInfo.destination)
                ?.uiTokenAmount.uiAmount || 0);

            const amountIn = Math.abs(tokenAChange);
            const amountOut = Math.abs(tokenBChange);

            if (amountIn > 0 && amountOut > 0) {
              const newSwap: SwapData = {
                timestamp: tx.blockTime!,
                signature: tx.transaction.signatures[0],
                swappedFrom: swapInfo.source,
                swappedTo: swapInfo.destination,
                amountIn,
                amountOut,
                price: amountOut / amountIn,
              };
              chartData.push(newSwap); // 최신 데이터를 배열 맨 뒤에 추가 (시간순)
              console.log(
                `✅ [${new Date(
                  tx.blockTime! * 1000
                ).toLocaleString()}] 스왑 감지: ${amountIn.toFixed(
                  2
                )} -> ${amountOut.toFixed(2)} (가격: ${newSwap.price.toFixed(
                  6
                )})`
              );
            }
          }
        }
      }
    } catch (error) {
      // console.error("인덱싱 오류:", error); // 필요 시 주석 해제
    }
  }, POLLING_INTERVAL_MS);
}
