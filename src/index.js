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
  reset: "멘션차단초기화",
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
          .setDescription("차단할 채널 ID들. 쉼표나 공백으로 여러 개 입력 가능")
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
          .setDescription("해제할 채널 ID들. 쉼표나 공백으로 여러 개 입력 가능")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName(COMMANDS.list)
      .setDescription("현재 역할 멘션 발송 전 차단 대상 채널을 확인합니다.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName(COMMANDS.reset)
      .setDescription("현재 서버의 역할 멘션 차단 설정과 AutoMod 규칙을 모두 삭제합니다.")
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

function getConfiguredGuildIds() {
  const rawValue = [process.env.GUILD_IDS, process.env.GUILD_ID].filter(Boolean).join(",");

  return uniqueSnowflakes(rawValue.split(",").map((value) => value.trim()).filter(Boolean));
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

function parseChannelIds(input) {
  const tokens = input
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const channelIds = [];
  const invalidTokens = [];

  for (const token of tokens) {
    const channelId = parseChannelId(token);

    if (channelId) {
      channelIds.push(channelId);
    } else {
      invalidTokens.push(token);
    }
  }

  if (invalidTokens.length > 0) {
    throw new UserFacingError(`읽을 수 없는 채널 ID가 있습니다: ${invalidTokens.slice(0, 5).join(", ")}`);
  }

  return uniqueSnowflakes(channelIds);
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

async function fetchTargetChannels(guild, channelIds) {
  if (channelIds.length === 0) {
    throw new UserFacingError("채널 ID 또는 `<#채널ID>` 형태로 하나 이상 입력해주세요.");
  }

  const channels = [];

  for (const channelId of channelIds) {
    channels.push(await fetchTargetChannel(guild, channelId));
  }

  return channels;
}

async function findManagedAutoModRule(guild) {
  const rules = await guild.autoModerationRules.fetch();
  return rules.find((rule) => rule.name === MANAGED_RULE_NAME) ?? null;
}

async function deleteManagedAutoModRule(guild, reason) {
  await assertBotCanManageAutoMod(guild);
  const existingRule = await findManagedAutoModRule(guild);

  if (!existingRule) {
    return false;
  }

  await existingRule.delete(reason);
  return true;
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
    if (existingRule) {
      await existingRule.delete("Exempt channel limit exceeded; avoid blocking unconfigured channels");
    }

    throw new UserFacingError(
      [
        `현재 구성은 제외 채널이 ${exemptChannelIds.length}개라 AutoMod 제한(${MAX_EXEMPT_CHANNELS}개)을 넘습니다.`,
        `현재 차단 대상 채널은 ${blockedChannelIds.length}개입니다.`,
        `발송 전 차단을 적용하려면 차단 대상 채널을 최소 ${blockedChannelIds.length + exemptChannelIds.length - MAX_EXEMPT_CHANNELS}개로 늘려야 합니다.`,
        `/멘션차단 채널id:채널1,채널2,... 형태로 ${exemptChannelIds.length - MAX_EXEMPT_CHANNELS}개 이상 더 추가해주세요.`,
        "차단하지 않은 채널이 막히지 않도록 기존 AutoMod 규칙은 삭제했습니다.",
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

function formatChannelMentions(channelIds) {
  const shownChannelIds = channelIds.slice(0, 12);
  const remainingCount = channelIds.length - shownChannelIds.length;
  const suffix = remainingCount > 0 ? ` 외 ${remainingCount}개` : "";

  return `${shownChannelIds.map((channelId) => `<#${channelId}>`).join(", ")}${suffix}`;
}

async function handleBlock(interaction) {
  const channelIds = parseChannelIds(interaction.options.getString("채널id", true));

  const channels = await fetchTargetChannels(interaction.guild, channelIds);
  const config = await readConfig();
  const guildConfig = ensureGuildConfig(config, interaction.guildId);
  const targetChannelIds = channels.map((channel) => channel.id);
  const requestedBlockedIds = uniqueSnowflakes([...guildConfig.blockedChannelIds, ...targetChannelIds]);
  const result = await syncAutoModRule(interaction.guild, requestedBlockedIds);

  await saveGuildBlockedChannels(config, interaction.guildId, result.blockedChannelIds);
  await interaction.editReply({
    content: [
      `${formatChannelMentions(targetChannelIds)} 채널에서 역할 멘션을 발송 전에 차단합니다.`,
      `AutoMod 규칙: ${translateRuleAction(result.ruleAction)}`,
      `현재 차단 대상 채널 수: ${result.blockedChannelIds.length}`,
      `제외 채널 수: ${result.exemptChannelCount}/${MAX_EXEMPT_CHANNELS}`,
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

async function handleUnblock(interaction) {
  const channelIds = parseChannelIds(interaction.options.getString("채널id", true));

  await fetchTargetChannels(interaction.guild, channelIds);

  const config = await readConfig();
  const guildConfig = ensureGuildConfig(config, interaction.guildId);
  const unblockChannelIdSet = new Set(channelIds);
  const requestedBlockedIds = guildConfig.blockedChannelIds.filter(
    (id) => !unblockChannelIdSet.has(id),
  );
  const result = await syncAutoModRule(interaction.guild, requestedBlockedIds);

  await saveGuildBlockedChannels(config, interaction.guildId, result.blockedChannelIds);
  await interaction.editReply({
    content: [
      `${formatChannelMentions(channelIds)} 채널의 역할 멘션 발송 전 차단을 해제했습니다.`,
      `AutoMod 규칙: ${translateRuleAction(result.ruleAction)}`,
      `남은 차단 채널 수: ${result.blockedChannelIds.length}`,
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

async function handleList(interaction) {
  const config = await readConfig();
  const blockedChannelIds = config.guilds[interaction.guildId]?.blockedChannelIds ?? [];

  await interaction.editReply({
    content: formatChannelList(blockedChannelIds),
    allowedMentions: { parse: [] },
  });
}

async function handleReset(interaction) {
  const config = await readConfig();
  const hadSavedConfig = Boolean(config.guilds[interaction.guildId]);
  const deletedRule = await deleteManagedAutoModRule(
    interaction.guild,
    "Reset role mention block config for this guild",
  );

  delete config.guilds[interaction.guildId];
  await writeConfig(config);
  await interaction.editReply({
    content: [
      "이 서버의 역할 멘션 차단 설정을 초기화했습니다.",
      `저장된 차단 채널: ${hadSavedConfig ? "삭제됨" : "없음"}`,
      `AutoMod 규칙: ${deletedRule ? "삭제됨" : "없음"}`,
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

function translateRuleAction(action) {
  switch (action) {
    case "created":
      return "생성됨";
    case "updated":
      return "갱신됨";
    case "deleted":
      return "삭제됨";
    default:
      return "변경 없음";
  }
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || !Object.values(COMMANDS).includes(interaction.commandName)) {
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    if (!interaction.guild || !interaction.guildId) {
      throw new UserFacingError("서버 안에서만 사용할 수 있는 명령어입니다.");
    }

    assertUserCanUseCommand(interaction);

    if (interaction.commandName === COMMANDS.block) {
      await handleBlock(interaction);
      return;
    }

    if (interaction.commandName === COMMANDS.unblock) {
      await handleUnblock(interaction);
      return;
    }

    if (interaction.commandName === COMMANDS.list) {
      await handleList(interaction);
      return;
    }

    if (interaction.commandName === COMMANDS.reset) {
      await handleReset(interaction);
      return;
    }
  } catch (error) {
    const message =
      error instanceof UserFacingError
        ? error.message
        : "처리 중 오류가 발생했습니다. 콘솔 로그를 확인해주세요.";

    if (!(error instanceof UserFacingError)) {
      console.error(error);
    }

    await interaction.editReply({
      content: message,
      allowedMentions: { parse: [] },
    });
  }
}

async function registerCommands(client) {
  const commands = buildCommands();
  const guildIds = getConfiguredGuildIds();

  if (guildIds.length > 0) {
    let registeredGuildCount = 0;

    for (const guildId of guildIds) {
      try {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(commands);
        registeredGuildCount += 1;
        console.log(`Registered ${commands.length} guild commands in ${guild.name}.`);
      } catch (error) {
        console.error(`Failed to register guild commands in ${guildId}:`, error);
      }
    }

    if (registeredGuildCount === 0) {
      throw new Error("Failed to register commands in every configured guild.");
    }

    console.log(`Registered commands in ${registeredGuildCount}/${guildIds.length} configured guilds.`);
    return;
  }

  await client.application.commands.set(commands);
  console.log(`Registered ${commands.length} global commands.`);
}

async function syncGuildFromConfig(client, guildId) {
  const config = await readConfig();
  const blockedChannelIds = config.guilds[guildId]?.blockedChannelIds ?? [];

  if (blockedChannelIds.length === 0) {
    return;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);

  if (!guild) {
    return;
  }

  const result = await syncAutoModRule(guild, blockedChannelIds);

  if (result.blockedChannelIds.length !== blockedChannelIds.length) {
    await saveGuildBlockedChannels(config, guildId, result.blockedChannelIds);
  }
}

async function syncAllConfiguredGuilds(client) {
  const config = await readConfig();

  for (const guildId of Object.keys(config.guilds)) {
    try {
      await syncGuildFromConfig(client, guildId);
      console.log(`Synced AutoMod rule for guild ${guildId}.`);
    } catch (error) {
      console.error(`Failed to sync AutoMod rule for guild ${guildId}:`, error);
    }
  }
}

async function cleanupUnconfiguredManagedRules(client) {
  const config = await readConfig();
  const configuredGuildIds = new Set(
    Object.entries(config.guilds)
      .filter(([, guildConfig]) => guildConfig.blockedChannelIds.length > 0)
      .map(([guildId]) => guildId),
  );

  for (const guild of client.guilds.cache.values()) {
    if (configuredGuildIds.has(guild.id)) {
      continue;
    }

    try {
      const deletedRule = await deleteManagedAutoModRule(guild, "No saved role mention block config");
      if (deletedRule) {
        console.log(`Deleted stale managed AutoMod rule in ${guild.name}.`);
      }
    } catch (error) {
      console.error(`Failed to clean stale managed AutoMod rule in ${guild.id}:`, error);
    }
  }
}

const pendingGuildSyncs = new Map();

function queueGuildSync(client, guildId) {
  const pendingSync = pendingGuildSyncs.get(guildId);

  if (pendingSync) {
    clearTimeout(pendingSync);
  }

  pendingGuildSyncs.set(
    guildId,
    setTimeout(async () => {
      pendingGuildSyncs.delete(guildId);

      try {
        await syncGuildFromConfig(client, guildId);
        console.log(`Resynced AutoMod rule for guild ${guildId}.`);
      } catch (error) {
        console.error(`Failed to resync AutoMod rule for guild ${guildId}:`, error);
      }
    }, 1500),
  );
}

function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
  });
}

async function main() {
  const token = process.env.DISCORD_TOKEN?.trim();

  if (!token) {
    throw new Error("DISCORD_TOKEN is required. Copy .env.example to .env and fill it in.");
  }

  const client = createClient();

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}.`);
    await registerCommands(readyClient);
    await cleanupUnconfiguredManagedRules(readyClient);
    await syncAllConfiguredGuilds(readyClient);
  });

  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.ChannelCreate, (channel) => {
    if (channel.guildId && isEligibleAutoModChannel(channel)) {
      queueGuildSync(client, channel.guildId);
    }
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (channel.guildId) {
      queueGuildSync(client, channel.guildId);
    }
  });

  await client.login(token);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

