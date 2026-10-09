# 시장 체온 앱 — 배포 요약

공포·탐욕 지수 데일리 앱. **Node.js 단일 서버 + 정적 PWA**, 외부 npm 의존성 0개.
요구 사항: Node 18 이상(권장 22). 전체 배포 가이드는 전달받은 「배포 가이드」 문서 참고.

## 파일 구성

| 파일 | 역할 | 필수 |
|---|---|---|
| `server.js` | API 서버 · 정적 파일 제공 · 데이터 수집·캐시 | 필수 |
| `index.html` | 화면 전체(UI · 차트 · 스크립트) | 필수 |
| `package.json` | 시작 명령(`node server.js`) | 필수 |
| `manifest.json`, `icon.svg`, `sw.js` | PWA(앱 설치 · 오프라인 캐시) | 권장 |
| `krx-key.txt`, `symbols.json` | KRX 키 · 사용자 종목 저장(자동 생성, **Git에 올리지 않음**) | 선택 |

## 로컬 실행

```bash
node -v                 # 18 이상 확인
unzip fear-greed-app.zip -d market-app && cd market-app
KRX_KEY=발급받은키 node server.js   # 키는 선택
# → http://localhost:8080
```

의존성이 없어 `npm install` 없이 바로 실행됩니다. 첫 화면 데이터 수집에 수십 초 걸릴 수 있습니다.

백그라운드 실행:
```bash
npm install -g pm2 && pm2 start server.js --name fear && pm2 save && pm2 startup
```

## Render 배포 (권장)

1. 비밀키 파일을 제외하고 GitHub에 저장소를 만든다.
2. Render → **New + → Web Service** → 저장소 연결.
3. 설정:

   | 항목 | 값 |
   |---|---|
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |

4. **Environment** 탭에 `KRX_KEY` 추가(선택).
5. Create → `https://내앱.onrender.com`

> 무료 플랜은 유휴 시 잠들고 첫 접속이 느릴 수 있습니다.

Railway / Fly.io도 동일: 시작 명령 `node server.js`, 환경변수 `KRX_KEY`.

## 환경변수

| 이름 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `PORT` | 아니오 | 8080 | 배포 플랫폼이 자동 주입 |
| `KRX_KEY` | 선택 | 없음 | 한국거래소 오픈API 인증키. 없으면 KRX 카드만 안내 문구 |

## KRX 오픈API 키

- 발급: <https://openapi.krx.co.kr/> 마이페이지 → API 인증키 신청
- **주의: 인증키 발급과 "데이터별 이용신청·승인"은 별개.** 승인 없이 호출하면 `401`.
- 이 앱이 쓰는 서비스: `idx/kospi_dd_trd`, `idx/kosdaq_dd_trd`, `idx/krx_dd_trd`,
  `sto/stk_bydd_trd`, `sto/ksq_bydd_trd`, `sto/stk_isu_base_info`,
  `etp/etf_bydd_trd`, `gen/gold_bydd_trd`, `gen/oil_bydd_trd`
- **외국인 순매수(투자자별 거래실적)는 KRX 오픈API에서 제공되지 않습니다.**

## 갱신 (덮어쓰기)

```bash
git pull --rebase
cp /tmp/new/server.js /tmp/new/index.html .   # 바꾼 파일만 복사
git add -A && git commit -m "업데이트" && git push
```
`main` 브랜치에 push되면 Render가 자동 재배포합니다. 환경변수는 유지됩니다.

## 주의

- **비밀키 파일(`krx-key.txt`)은 Git에 올리지 마세요** — `.gitignore`에 등록되어 있습니다. 키는 환경변수 `KRX_KEY`로.
- 브라우저 알림(관심종목·매수 신호·골든크로스·망치형)은 **앱이 열려 있을 때만** 동작합니다.
  정해진 시각 자동 실행은 스케줄러(Genspark Workflows 등)가 필요합니다.
- 투자 판단 참고용이며 투자 권유가 아닙니다.
