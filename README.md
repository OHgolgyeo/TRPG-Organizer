# TRPG Organizer

TRPG 시나리오와 자료를 정리하고 Roll20 또는 CCFOLIA의 채팅 입력창으로 빠르게 전송하기 위한 프로그램입니다.

- Windows: 자동 탐색 / 직접 지정 전송
- macOS: 접근성(손쉬운 사용) 기반 자동 탐색 / 직접 지정 전송
- 문서 편집, 검색/바꾸기, 스타일, 명령어, 서브뷰, 메모, 포스트잇, 코멘트, 북마크

저장소: https://github.com/OHgolgyeo/TRPG-Organizer

> macOS 빌드는 개인 전달용 무서명 빌드를 전제로 하며 실제 Mac 기기 테스트는 별도로 필요합니다.

## 빌드

```bash
npm install
npm run dist:win   # Windows
npm run dist:mac   # macOS (Mac 환경)
```

GitHub Actions를 사용하면 Mac이 없어도 GitHub의 macOS 러너에서 macOS 빌드를 만들 수 있습니다.
