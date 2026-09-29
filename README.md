# 서진 수업 자료실

서울서진학교 수업에서 쓰는 안내와 프로그램입니다. 파일 한 장이라 설치가 필요 없고, 내려받아 두면 인터넷 없이도 열립니다.

- 자료실: https://woosiq92.github.io/seojin-tools/

## 디지털 소양 교육

터치스크린으로 누르고 고르고 끌기, 마우스로 포인터 옮기고 클릭하기, 키보드로 키 찾고 글자와 낱말 치기를 학교급마다 5단계씩 연습합니다.

- 열기: https://woosiq92.github.io/seojin-tools/digital/
- 내려받아 쓰기: `digital/index.html` 을 저장한 뒤 크롬으로 열면 됩니다.

전자칠판에 띄우고 학생이 나와서 만지는 방식을 생각하고 만들었습니다. 활동 중 왼쪽 위 ← 를 1초 누르면 단계 고르기 화면으로 돌아갑니다.

학생 이름이나 학습 기록은 저장하지 않습니다. 교사가 고른 설정(소리·크기·횟수 등)만 그 컴퓨터의 브라우저에 남습니다. 서버로 나가는 정보는 없습니다.

## 바이브 코딩 저장소

선생님들이 수업에 쓰고 싶은 도구를 요청하고, AI와 함께 만든 도구를 분류별로 모아 씁니다. 요청과 도구를 모두가 함께 봐야 해서
이것만은 서버가 있어야 합니다. GitHub Pages 는 정적 파일만 내보내므로 Railway 에서 돌립니다.

- 열기: https://seojin-tools-production.up.railway.app/s/seojin/
- 조직 이름으로 찾아 들어가기: https://seojin-tools-production.up.railway.app/s/

Railway 는 이 저장소 맨 위의 `package.json` 을 보고 `vibe/server.mjs` 를 돌립니다. 이 서버가 자료실의 정적 파일(`/`, `digital/`, `gear/`)도
그대로 함께 내보냅니다(`STATIC_ROOT=.`). 자료는 Railway 볼륨 `/data` 에 SQLite 파일 한 장으로 남습니다(변수 `DATA_DIR=/data`).
볼륨이 없으면 push 할 때마다 요청과 도구가 지워집니다.

`vibe/` 는 결과물입니다. 원본은 비공개 저장소 seojin 의 `shelf/` 와 `저장소.html` 이고, 거기서 고친 뒤 이리로 옮깁니다.
공간은 `vibe/spaces.json` 에 적어 두면 서버가 켜질 때 없는 것만 만듭니다(코드·열쇠는 Railway 로그에 한 번 찍힘).

## 카메라로 하는 도구 세 가지

바이브 코딩 저장소의 도구 모음에서 여는 페이지입니다. 카메라 영상은 기기 안에서만 처리하고 밖으로 보내지 않습니다.
손·얼굴 인식은 MediaPipe(jsDelivr·Google 저장소에서 받아 옴)를 쓰니 인터넷이 필요합니다.

- 사이에서 핀다: https://woosiq92.github.io/seojin-tools/bloom/
- 손으로 내는 소리: https://woosiq92.github.io/seojin-tools/hand-sound/
- 머리로 받는 소리: https://woosiq92.github.io/seojin-tools/head-notes/

원본은 이 컴퓨터의 `~/media-art`, `~/hand-sound`, `~/head-notes` 의 `index.html` 입니다.
