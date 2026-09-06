# TRPG Organizer 릴리스

## GitHub Actions로 빌드
1. 프로젝트 전체를 GitHub 저장소에 업로드합니다.
2. Actions → Cross-platform build → Run workflow로 Windows/macOS 빌드를 확인할 수 있습니다.
3. 정식 초안 릴리스를 만들 때는 `v0.1.0`처럼 버전 태그를 push합니다.
4. 워크플로가 Windows와 macOS를 각각 빌드한 뒤 **하나의 Draft Release**에 결과물을 모읍니다.
5. GitHub Releases에서 Draft를 확인한 뒤 직접 Publish release를 누릅니다.

`electron-builder --publish`를 병렬로 실행하지 않으므로 같은 버전의 Draft Release가 여러 개 생기지 않습니다.
