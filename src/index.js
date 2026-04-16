require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");

const COMMANDS = {
  block: "멘션차단",
  unblock: "멘션차단해제",
  list: "멘션차단목록",
};

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "mention-blocks.json");
const MANAGED_RULE_NAME = "역할 멘션 차단 (bot-managed)";
const ROLE_MENTION_REGEX = "<@&[0-9]{17,20}>";
const BLOCK_MESSAGE = "이 채널에서는 역할 멘션을 사용할 수 없습니다.";
const MAX_EXEMPT_CHANNELS = 50;
const MAX_EXEMPT_ROLES = 20;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const CHANNEL_MENTION_RE = /^<#(\d{17,20})>$/;

const AUTO_MOD_CHANNEL_TYPES = new Set(
  [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
    ChannelType.GuildVoice,
  ].filter((value) => Number.isInteger(value)),
);

class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserFacingError";
  }
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName(COMMANDS.block)
      .setDescription("선택한 채널에서 일반 유저의 역할 멘션 발송을 차단합니다.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addStringOption((option) =>
        option
          .setName("채널id")
          .setDescription("차단할 채널 ID 또는 <#채널ID>")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName(COMMANDS.unblock)
      .setDescription("선택한 채널의 역할 멘션 발송 전 차단을 해제합니다.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addStringOption((option) =>
        option
          .setName("채널id")
          .setDescription("해제할 채널 ID 또는 <#채널ID>")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName(COMMANDS.list)
      .setDescription("현재 역할 멘션 발송 전 차단 대상 채널을 확인합니다.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false),
  ].map((command) => command.toJSON());
}

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { guilds: {} };
    }

    throw error;
  }
}

function normalizeConfig(config) {
  const normalized = { guilds: {} };
  const guilds = config && typeof config === "object" ? config.guilds : null;

  if (!guilds || typeof guilds !== "object") {
    return normalized;
  }

  for (const [guildId, guildConfig] of Object.entries(guilds)) {
    if (!SNOWFLAKE_RE.test(guildId)) {
      continue;
    }

    const blockedChannelIds = Array.isArray(guildConfig?.blockedChannelIds)
      ? guildConfig.blockedChannelIds
      : [];

    normalized.guilds[guildId] = {
      blockedChannelIds: uniqueSnowflakes(blockedChannelIds),
    };
  }

  return normalized;
}

async function writeConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const nextConfig = normalizeConfig(config);
  const tmpPath = `${CONFIG_PATH}.tmp`;

  await fs.writeFile(tmpPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, CONFIG_PATH);
}

function uniqueSnowflakes(values) {
  return [...new Set(values.map(String).filter((value) => SNOWFLAKE_RE.test(value)))];
}

function parseChannelId(input) {
  const value = input.trim();
  const mentionMatch = value.match(CHANNEL_MENTION_RE);

  if (mentionMatch) {
    return mentionMatch[1];
  }

  if (SNOWFLAKE_RE.test(value)) {
    return value;
  }

  return null;
}

function ensureGuildConfig(config, guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = { blockedChannelIds: [] };
  }

  return config.guilds[guildId];
}

function isEligibleAutoModChannel(channel) {
  return channel?.guild && AUTO_MOD_CHANNEL_TYPES.has(channel.type);
}

function getEligibleAutoModChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter(isEligibleAutoModChannel)
    .sort((left, right) => {
      if (left.rawPosition !== right.rawPosition) {
        return left.rawPosition - right.rawPosition;
      }

      return left.id.localeCompare(right.id);
    });
}

function getExtraExemptRoleIds(guild) {
  const rawValue = process.env.EXTRA_EXEMPT_ROLE_IDS ?? "";
  const ids = uniqueSnowflakes(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ).filter((roleId) => guild.roles.cache.has(roleId));

  if (ids.length > MAX_EXEMPT_ROLES) {
    throw new UserFacingError(
      `추가 예외 역할은 최대 ${MAX_EXEMPT_ROLES}개까지만 넣을 수 있습니다.`,
    );
  }

  return ids;
}

async function assertBotCanManageAutoMod(guild) {
  const botMember = await guild.members.fetchMe();

  if (!botMember.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserFacingError("봇에 `Manage Server` 권한이 필요합니다.");
  }
}

function assertUserCanUseCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserFacingError("이 명령어는 `Manage Server` 권한이 있는 사람만 사용할 수 있습니다.");
  }
}

async function fetchTargetChannel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);

  if (!channel || channel.guildId !== guild.id) {
    throw new UserFacingError("해당 서버에서 채널을 찾을 수 없습니다.");
  }

  if (!isEligibleAutoModChannel(channel)) {
    throw new UserFacingError(
      "텍스트/공지/포럼/미디어/음성 채널 ID만 사용할 수 있습니다. 스레드는 부모 채널에 설정해주세요.",
    );
  }

  return channel;
}

async function findManagedAutoModRule(guild) {
  const rules = await guild.autoModerationRules.fetch();
  return rules.find((rule) => rule.name === MANAGED_RULE_NAME) ?? null;
}

async function syncAutoModRule(guild, requestedBlockedChannelIds) {
  await assertBotCanManageAutoMod(guild);
  await guild.channels.fetch();
  await guild.roles.fetch();

  const eligibleChannels = getEligibleAutoModChannels(guild);
  const eligibleChannelIds = new Set(eligibleChannels.map((channel) => channel.id));
  const blockedChannelIds = uniqueSnowflakes(requestedBlockedChannelIds).filter((channelId) =>
    eligibleChannelIds.has(channelId),
  );
  const existingRule = await findManagedAutoModRule(guild);

  if (blockedChannelIds.length === 0) {
    if (existingRule) {
      await existingRule.delete("No blocked channels remain");
    }

    return {
      blockedChannelIds,
      exemptChannelCount: 0,
      ruleAction: existingRule ? "deleted" : "none",
    };
  }

  const blockedChannelIdSet = new Set(blockedChannelIds);
  const exemptChannelIds = eligibleChannels
    .map((channel) => channel.id)
    .filter((channelId) => !blockedChannelIdSet.has(channelId));

  if (exemptChannelIds.length > MAX_EXEMPT_CHANNELS) {
    throw new UserFacingError(
      [
        `현재 구성은 제외 채널이 ${exemptChannelIds.length}개라 AutoMod 제한(${MAX_EXEMPT_CHANNELS}개)을 넘습니다.`,
        "발송 전 차단을 특정 채널에만 적용하려면 차단 대상 채널을 늘리거나 서버 채널 구조를 줄여야 합니다.",
      ].join("\n"),
    );
  }

  const rulePayload = {
    name: MANAGED_RULE_NAME,
    eventType: AutoModerationRuleEventType.MessageSend,
    triggerType: AutoModerationRuleTriggerType.Keyword,
    triggerMetadata: {
      regexPatterns: [ROLE_MENTION_REGEX],
    },
    actions: [
      {
        type: AutoModerationActionType.BlockMessage,
        metadata: {
          customMessage: BLOCK_MESSAGE,
        },
      },
    ],
    enabled: true,
    exemptChannels: exemptChannelIds,
    exemptRoles: getExtraExemptRoleIds(guild),
  };

  if (existingRule) {
    await existingRule.edit({
      ...rulePayload,
      reason: "Update role mention block channels",
    });

    return {
      blockedChannelIds,
      exemptChannelCount: exemptChannelIds.length,
      ruleAction: "updated",
    };
  }

  await guild.autoModerationRules.create({
    ...rulePayload,
    reason: "Create role mention block rule",
  });

  return {
    blockedChannelIds,
    exemptChannelCount: exemptChannelIds.length,
    ruleAction: "created",
  };
}

async function saveGuildBlockedChannels(config, guildId, blockedChannelIds) {
  if (blockedChannelIds.length === 0) {
    delete config.guilds[guildId];
  } else {
    config.guilds[guildId] = { blockedChannelIds };
  }

  await writeConfig(config);
}

function formatChannelList(channelIds) {
  if (channelIds.length === 0) {
    return "현재 역할 멘션 차단 대상 채널이 없습니다.";
  }

  return [
    "현재 역할 멘션 차단 대상 채널입니다.",
    "",
    ...channelIds.map((channelId) => `- <#${channelId}> (${channelId})`),
  ].join("\n");
}

async function handleBlock(interaction) {
  const channelId = parseChannelId(interaction.options.getString("채널id", true));

  if (!channelId) {
    throw new UserFacingError("채널 ID 또는 `<#채널ID>` 형태로 입력해주세요.");
  }

  const channel = await fetchTargetChannel(interaction.guild, channelId);
  const config = await readConfig();
  const guildConfig = ensureGuildConfig(config, interaction.guildId);
  const requestedBlockedIds = uniqueSnowflakes([...guildConfig.blockedChannelIds, channel.id]);
  const result = await syncAutoModRule(interaction.guild, requestedBlockedIds);

  await saveGuildBlockedChannels(config, interaction.guildId, result.blockedChannelIds);
  await interaction.editReply({
    content: [
      `<#${channel.id}> 채널에서 역할 멘션을 발송 전에 차단합니다.`,
      `AutoMod 규칙: ${translateRuleAction(result.ruleAction)}`,
      `제외 채널 수: ${result.exemptChannelCount}/${MAX_EXEMPT_CHANNELS}`,
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

async function handleUnblock(interaction) {
  const channelId = parseChannelId(interaction.options.getString("채널id", true));

  if (!channelId) {
    throw new UserFacingError("채널 ID 또는 `<#채널ID>` 형태로 입력해주세요.");
  }
