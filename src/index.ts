import express from "express";
import { Request, Response } from "express";
import * as dotenv from "dotenv";
import { runIndexer, chartData } from "./indexer.js"; // 인덱서 모듈 임포트

// .env 파일의 환경 변수를 process.env로 로드합니다.
dotenv.config();

const app = express();
const API_PORT = parseInt(process.env.API_PORT || "3001");

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

// 차트 데이터 엔드포인트
app.get("/v1/main/chart", (req: Request, res: Response) => {
  const count = req.query.count ?? 10;
  let after: any = req.query.after;
  if (after == "null" || after == "undefined") after = null;

  let candles = chartData.slice(-count);
  if (after) {
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      if (candle.signature === after) {
        candles = candles.slice(i + 1);
        break;
      }
    }
  }
  res.json(candles);
});

// (이하 다른 더미 엔드포인트들은 필요에 따라 유지)
// ...

// 서버 실행 및 인덱서 시작
app.listen(API_PORT, () => {
  console.log(`✅ API 서버가 http://localhost:${API_PORT} 에서 실행 중입니다.`);

  // API 서버가 시작되면 인덱서를 함께 실행합니다.
  runIndexer();
});
