import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  Keypair,
} from "@solana/web3.js";
import * as fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { TOKEN_SWAP_PROGRAM_ID } from "@solana/spl-token-swap";
import { decodeSwapInstruction } from "./utils/decodeSwap.js";

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

        // swap 프로그램 호출 인스트럭션만 필터링
        const swapInstructions = tx.transaction.message.instructions.filter(
          (i) => i.programId.equals(TOKEN_SWAP_PROGRAM_ID)
        );
        for (const inst of swapInstructions) {
          // PartiallyDecodedInstruction 타입: data(base58) 와 계정 인덱스 보유
          const decoded = decodeSwapInstruction((inst as any).data);
          if (!decoded) continue; // 태그가 1(Swap)이 아니면 스킵

          /** ---------- 토큰 밸런스 변화 계산 ---------- */
          const pre = tx.meta!.preTokenBalances!;
          const post = tx.meta!.postTokenBalances!;

          // 계정 인덱스 → balance delta(uiAmount) 매핑
          const deltaByMint = new Map<string, number>();

          for (const bal of pre) {
            const after = post.find((p) => p.accountIndex === bal.accountIndex);
            const delta =
              (after?.uiTokenAmount.uiAmount ?? 0) -
              (bal.uiTokenAmount.uiAmount ?? 0);

            if (delta !== 0) {
              deltaByMint.set(
                bal.mint,
                (deltaByMint.get(bal.mint) || 0) + delta
              );
            }
          }

          // 음수(보낸 쪽), 양수(받은 쪽) 중 절댓값이 큰 두 Mint 추출
          const sorted = [...deltaByMint.entries()].sort((a, b) => a[1] - b[1]);
          if (sorted.length < 2) continue;

          const [fromMint, fromDelta] = sorted[0]; // 가장 음수 → amountIn
          const [toMint, toDelta] = sorted[sorted.length - 1]; // 가장 양수 → amountOut
          const amountIn = Math.abs(fromDelta);
          const amountOut = toDelta;

          /** ---------- 차트 데이터 push ---------- */
          if (amountIn > 0 && amountOut > 0) {
            chartData.push({
              timestamp: tx.blockTime!,
              signature: tx.transaction.signatures[0],
              swappedFrom: fromMint,
              swappedTo: toMint,
              amountIn,
              amountOut,
              price: amountOut / amountIn,
            });

            console.log(
              `✅ [${new Date(tx.blockTime! * 1000).toLocaleTimeString()}] ` +
                `스왑 감지: ${amountIn.toFixed(2)} → ${amountOut.toFixed(2)}`
            );
          }
        }
      }
    } catch (error) {
      // console.error("인덱싱 오류:", error); // 필요 시 주석 해제
    }
  }, POLLING_INTERVAL_MS);
}
