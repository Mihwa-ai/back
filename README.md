# Team Dream Backend

Supabase 기반 백엔드 프로젝트입니다. Render Web Service(무료 티어)로 배포하고, 자사 서버가 주기적으로 HTTP 요청을 보내 크롤링을 트리거하는 방식으로 데이터를 수집합니다.

## 구조

```
src/
  config.js           # 환경변수 로딩
  supabaseClient.js    # Supabase client
  server.js            # Express 서버, 크롤링 트리거 엔드포인트
  crawlers/
    base.js            # Crawler 베이스 클래스 (fetch -> parse -> save)
    example.js         # 크롤러 작성 템플릿
    index.js           # CRAWLERS 레지스트리
  jobs/
    runCrawl.js         # 로컬에서 크롤러를 CLI로 직접 실행할 때 사용
render.yaml             # Render Web Service 정의
```

## 로컬 실행

```bash
npm install
cp .env.example .env  # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRAWL_TRIGGER_SECRET 채우기
npm start
```

## 크롤링 트리거

자사 서버(또는 외부 스케줄러)가 아래처럼 호출합니다.

```bash
curl -X POST https://<render-service>.onrender.com/crawl/example \
  -H "x-crawl-secret: $CRAWL_TRIGGER_SECRET"
```

- `GET /health` : Render 헬스체크용
- `POST /crawl/:job` : `x-crawl-secret` 헤더가 `CRAWL_TRIGGER_SECRET`과 일치해야 실행됨

무료 웹서비스는 15분간 요청이 없으면 스핀다운되며, 다음 요청 시 콜드스타트(약 30초~1분)가 발생합니다.

## 로컬에서 크롤러만 바로 실행

```bash
npm run crawl -- --job example
```

## 새 크롤러 추가하기

1. `src/crawlers/`에 `example.js`를 복사해 새 파일 생성, `fetch`/`parse` 구현
2. `src/crawlers/index.js`의 `CRAWLERS` 맵에 등록
3. 자사 스케줄러에서 `POST /crawl/<새 job 이름>`을 호출하도록 등록
