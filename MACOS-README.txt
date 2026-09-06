TRPG Organizer - macOS 전달용 안내

이 macOS 빌드는 개인 전달용 무서명 빌드입니다.

[처음 실행]
macOS가 개발자를 확인할 수 없다는 경고를 표시할 수 있습니다.
Finder에서 TRPG Organizer를 Control+클릭(또는 우클릭) → 열기 → 열기를 선택하세요.

그래도 “손상되어 열 수 없습니다”처럼 차단되는 경우 터미널에서 아래 명령을 실행한 뒤 다시 열 수 있습니다.

xattr -dr com.apple.quarantine "/Applications/TRPG Organizer.app"

[채팅 전송]
자동 탐색 모드와 직접 지정 모드는 macOS의 손쉬운 사용 권한을 이용합니다.
시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 TRPG Organizer를 허용하세요.

[업데이트]
무서명 macOS 전달용 빌드는 앱 내 자동 업데이트를 사용하지 않습니다.
새 버전을 전달받으면 기존 앱을 새 앱으로 교체해 주세요.

[호환]
Apple Silicon(arm64)과 Intel(x64)용 빌드를 각각 제공합니다.
실제 Mac 기기에서의 동작 검증은 아직 이루어지지 않았습니다.
