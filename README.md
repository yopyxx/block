# 역할 멘션 발송 전 차단 봇

Discord AutoMod 규칙을 봇이 관리해서 특정 채널에서 역할 멘션을 발송 전에 차단합니다. 사용자 멘션은 막지 않습니다.

## 동작 방식

- `/멘션차단 채널id`를 실행하면 입력한 채널들을 역할 멘션 차단 대상으로 저장합니다.
- 봇은 AutoMod 규칙 하나를 만들거나 갱신합니다.
- 역할 멘션 원문인 `<@&역할ID>`만 정규식으로 잡습니다.
- 일반 사용자 멘션인 `<@사용자ID>`는 정규식에 걸리지 않습니다.
- Discord AutoMod 특성상 `Administrator` 또는 `Manage Server` 권한 보유자는 기본적으로 예외 처리됩니다.
- Ticket Tool 채널 자동 등록을 켜면 새 티켓 채널이 `/멘션차단` 목록에 자동으로 추가됩니다.

## 제한 사항

AutoMod에는 "이 채널에만 적용" 옵션이 없고, "이 채널들은 제외" 옵션만 있습니다. 그래서 봇은 서버의 다른 채널들을 `exempt_channels`에 넣어 한 채널만 적용되게 만듭니다.

Discord의 `exempt_channels` 제한 때문에 제외해야 할 채널이 50개를 넘으면 AutoMod 발송 전 차단 구성이 불가능합니다. 이 경우 봇은 Ticket Tool처럼 채널이 계속 늘어나는 서버에서도 다른 채널이 막히지 않도록 채널 권한 fallback으로 전환합니다.

Ticket Tool이 만드는 채널을 자동으로 차단 대상에 넣으면, 티켓 채널이 쌓여도 `exempt_channels` 수가 덜 늘어나 AutoMod 발송 전 차단을 계속 유지하기 쉬워집니다. 티켓 채널이 들어가는 카테고리 ID를 `AUTO_BLOCK_CATEGORY_IDS`에 넣는 방식을 권장합니다.

채널 권한 fallback은 차단 대상 채널의 `@everyone` 권한에서 `MentionEveryone`을 거부합니다. 이 방식은 채널 수가 계속 늘어나도 차단하지 않은 채널에 영향을 주지 않습니다. 다만 역할 자체가 "누구나 멘션 가능"으로 설정되어 있으면 Discord 권한 구조상 AutoMod만큼 강하게 막지 못할 수 있습니다.

제외 채널이 50개 이하로 줄어들거나 차단 대상 채널을 충분히 늘리면, 봇은 다시 AutoMod 발송 전 차단을 사용하고 이전 fallback 권한을 원래대로 복구합니다.

봇은 시작할 때 저장된 차단 설정이 없는 서버의 `역할 멘션 차단 (bot-managed)` AutoMod 규칙을 자동으로 삭제합니다.

## 준비

1. Node.js 18.17 이상을 설치합니다.
2. Discord Developer Portal에서 봇을 만들고 토큰을 발급합니다.
3. 봇 초대 시 scope는 `bot`, `applications.commands`를 넣습니다.
4. 봇 권한에는 `Manage Server`가 필요합니다. Ticket Tool처럼 채널이 계속 늘어나는 서버에서는 fallback을 위해 `Manage Channels`도 필요합니다.
5. `.env.example`을 참고해 `.env` 파일을 만듭니다.

```env
DISCORD_TOKEN=your_bot_token_here
GUILD_IDS=1386716926516133949,1279685629751459902
EXTRA_EXEMPT_ROLE_IDS=
AUTO_BLOCK_CATEGORY_IDS=
AUTO_BLOCK_CHANNEL_NAME_PREFIXES=ticket-,티켓-
AUTO_BLOCK_NEW_CHANNELS=false
```

Ticket Tool 자동 등록 설정:

```env
# 티켓 채널이 생성되는 카테고리 ID를 쉼표로 구분합니다. 가장 권장되는 방식입니다.
AUTO_BLOCK_CATEGORY_IDS=123456789012345678,234567890123456789

# 카테고리 대신 채널 이름 prefix로 자동 등록할 수 있습니다.
AUTO_BLOCK_CHANNEL_NAME_PREFIXES=ticket-,티켓-,문의-

# true로 두면 새로 생기는 모든 적용 가능 채널을 차단 대상으로 넣습니다.
# 일반 채널까지 자동 차단될 수 있으므로 보통 false로 둡니다.
AUTO_BLOCK_NEW_CHANNELS=false
```

봇이 시작할 때 이미 쌓여 있는 Ticket Tool 채널도 한 번 스캔해서 차단 목록에 추가합니다. 이후 새 채널이 생성되거나 이름/카테고리가 바뀌어 조건에 맞으면 자동으로 추가됩니다.

## 실행

```bash
npm install
npm start
```

## 명령어

```text
/멘션차단 채널id:123456789012345678
/멘션차단 채널id:123456789012345678,234567890123456789,345678901234567890
/멘션차단 채널id:<#123456789012345678> <#234567890123456789>
/멘션차단해제 채널id:123456789012345678
/멘션차단목록
/멘션차단초기화
```

`채널id`에는 순수 채널 ID나 `<#채널ID>` 형태를 넣을 수 있습니다. 여러 개를 넣을 때는 쉼표, 공백, 줄바꿈으로 구분하면 됩니다.

`/멘션차단초기화`는 현재 서버의 저장된 차단 채널, 봇이 만든 AutoMod 규칙, 봇이 적용한 채널 권한 fallback을 모두 복구/삭제합니다.

여러 서버에서 쓰려면 봇을 각 서버에 초대한 뒤 `.env`의 `GUILD_IDS`에 서버 ID를 쉼표로 구분해 넣으면 됩니다. 기존 `GUILD_ID` 하나만 넣는 방식도 호환됩니다.

## 참고

새 채널이 생기거나 삭제되면 봇이 AutoMod 예외 채널 목록을 다시 동기화합니다. 봇이 꺼져 있는 동안 새 채널이 만들어지면 예외 목록이 오래될 수 있으니, 이 봇은 계속 켜두는 것이 좋습니다.
