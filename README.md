# 역할 멘션 발송 전 차단 봇

Discord AutoMod 규칙을 봇이 관리해서 특정 채널에서 역할 멘션을 발송 전에 차단합니다. 사용자 멘션은 막지 않습니다.

## 동작 방식

- `/멘션차단 채널id`를 실행하면 해당 채널만 역할 멘션 차단 대상으로 저장합니다.
- 봇은 AutoMod 규칙 하나를 만들거나 갱신합니다.
- 역할 멘션 원문인 `<@&역할ID>`만 정규식으로 잡습니다.
- 일반 사용자 멘션인 `<@사용자ID>`는 정규식에 걸리지 않습니다.
- Discord AutoMod 특성상 `Administrator` 또는 `Manage Server` 권한 보유자는 기본적으로 예외 처리됩니다.

## 제한 사항

AutoMod에는 "이 채널에만 적용" 옵션이 없고, "이 채널들은 제외" 옵션만 있습니다. 그래서 봇은 서버의 다른 채널들을 `exempt_channels`에 넣어 한 채널만 적용되게 만듭니다.

Discord의 `exempt_channels` 제한 때문에 제외해야 할 채널이 50개를 넘으면 특정 채널만 발송 전 차단하는 구성이 불가능합니다. 이 경우 봇이 명령어 응답으로 알려줍니다.

## 준비

1. Node.js 18.17 이상을 설치합니다.
2. Discord Developer Portal에서 봇을 만들고 토큰을 발급합니다.
3. 봇 초대 시 scope는 `bot`, `applications.commands`를 넣습니다.
4. 봇 권한에는 `Manage Server`가 필요합니다.
5. `.env.example`을 참고해 `.env` 파일을 만듭니다.

```env
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=테스트할_서버_ID
EXTRA_EXEMPT_ROLE_IDS=
```

## 실행

```bash
npm install
npm start
```

## 명령어

```text
/멘션차단 채널id:123456789012345678
/멘션차단해제 채널id:123456789012345678
/멘션차단목록
```

`채널id`에는 순수 채널 ID나 `<#채널ID>` 형태를 넣을 수 있습니다.

## 참고

새 채널이 생기거나 삭제되면 봇이 AutoMod 예외 채널 목록을 다시 동기화합니다. 봇이 꺼져 있는 동안 새 채널이 만들어지면 예외 목록이 오래될 수 있으니, 이 봇은 계속 켜두는 것이 좋습니다.
