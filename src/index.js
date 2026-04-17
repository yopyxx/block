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
const PERMISSION_FALLBACK_STATES = new Set(["allow", "deny", "unset"]);

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
    const permissionFallbacks =
      guildConfig?.permissionFallbacks && typeof guildConfig.permissionFallbacks === "object"
        ? Object.fromEntries(
            Object.entries(guildConfig.permissionFallbacks)
              .filter(([channelId, state]) => SNOWFLAKE_RE.test(channelId) && PERMISSION_FALLBACK_STATES.has(state)),
          )
        : {};

    normalized.guilds[guildId] = {
      blockedChannelIds: uniqueSnowflakes(blockedChannelIds),
      permissionFallbacks,
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
    config.guilds[guildId] = { blockedChannelIds: [], permissionFallbacks: {} };
  }

  if (!config.guilds[guildId].permissionFallbacks) {
    config.guilds[guildId].permissionFallbacks = {};
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

function getMentionEveryoneOverwriteState(channel) {
  const everyoneOverwrite = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);

  if (!everyoneOverwrite) {
    return "unset";
  }

  if (everyoneOverwrite.allow.has(PermissionFlagsBits.MentionEveryone)) {
    return "allow";
  }

  if (everyoneOverwrite.deny.has(PermissionFlagsBits.MentionEveryone)) {
    return "deny";
  }

  return "unset";
}

function permissionValueFromFallbackState(state) {
  if (state === "allow") {
    return true;
  }

  if (state === "deny") {
    return false;
  }

  return null;
}

async function assertBotCanManageChannel(channel, botMember) {
  const permissions = channel.permissionsFor(botMember);

  if (!permissions?.has(PermissionFlagsBits.ManageChannels)) {
    throw new UserFacingError(`봇에 <#${channel.id}> 채널의 \`Manage Channels\` 권한이 필요합니다.`);
  }
}

async function restorePermissionFallbacks(guild, permissionFallbacks) {
  const botMember = await guild.members.fetchMe();
  const nextPermissionFallbacks = { ...permissionFallbacks };
  let restoredCount = 0;

  for (const [channelId, previousState] of Object.entries(permissionFallbacks)) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (channel && isEligibleAutoModChannel(channel)) {
      await assertBotCanManageChannel(channel, botMember);
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { MentionEveryone: permissionValueFromFallbackState(previousState) },
        { reason: "Restore role mention permission fallback" },
      );
      restoredCount += 1;
    }

    delete nextPermissionFallbacks[channelId];
  }

  return { permissionFallbacks: nextPermissionFallbacks, restoredCount };
}

async function syncPermissionFallbacks(guild, blockedChannelIds, permissionFallbacks) {
  const botMember = await guild.members.fetchMe();
  const targetChannelIdSet = new Set(blockedChannelIds);
  const nextPermissionFallbacks = { ...permissionFallbacks };
  let appliedCount = 0;
  let restoredCount = 0;

  for (const [channelId, previousState] of Object.entries(permissionFallbacks)) {
    if (targetChannelIdSet.has(channelId)) {
      continue;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (channel && isEligibleAutoModChannel(channel)) {
      await assertBotCanManageChannel(channel, botMember);
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { MentionEveryone: permissionValueFromFallbackState(previousState) },
        { reason: "Restore role mention permission fallback" },
      );
      restoredCount += 1;
    }

    delete nextPermissionFallbacks[channelId];
  }

  for (const channelId of blockedChannelIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (!channel || !isEligibleAutoModChannel(channel)) {
      delete nextPermissionFallbacks[channelId];
      continue;
    }

    await assertBotCanManageChannel(channel, botMember);

    if (!Object.prototype.hasOwnProperty.call(nextPermissionFallbacks, channelId)) {
      nextPermissionFallbacks[channelId] = getMentionEveryoneOverwriteState(channel);
    }

    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { MentionEveryone: false },
      { reason: "Fallback role mention block for this channel" },
    );
    appliedCount += 1;
  }

  return { permissionFallbacks: nextPermissionFallbacks, appliedCount, restoredCount };
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

async function syncAutoModRule(guild, requestedBlockedChannelIds, permissionFallbacks = {}) {
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
    const permissionResult = await restorePermissionFallbacks(guild, permissionFallbacks);

    if (existingRule) {
      await existingRule.delete("No blocked channels remain");
    }

    return {
      blockedChannelIds,
      exemptChannelCount: 0,
      mode: "none",
      permissionFallbacks: permissionResult.permissionFallbacks,
      permissionAppliedCount: 0,
      permissionRestoredCount: permissionResult.restoredCount,
      ruleAction: existingRule ? "deleted" : "none",
    };
  }

  const blockedChannelIdSet = new Set(blockedChannelIds);
  const exemptChannelIds = eligibleChannels
    .map((channel) => channel.id)
    .filter((channelId) => !blockedChannelIdSet.has(channelId));

  if (exemptChannelIds.length > MAX_EXEMPT_CHANNELS) {
    const ruleAction = existingRule ? "deleted" : "none";

    if (existingRule) {
      await existingRule.delete("Exempt channel limit exceeded; avoid blocking unconfigured channels");
    }

    const permissionResult = await syncPermissionFallbacks(guild, blockedChannelIds, permissionFallbacks);

    return {
      blockedChannelIds,
      exemptChannelCount: exemptChannelIds.length,
      mode: "channel-permissions",
      minimumBlockedChannelCount: blockedChannelIds.length + exemptChannelIds.length - MAX_EXEMPT_CHANNELS,
      neededAdditionalBlockedChannels: exemptChannelIds.length - MAX_EXEMPT_CHANNELS,
      permissionFallbacks: permissionResult.permissionFallbacks,
      permissionAppliedCount: permissionResult.appliedCount,
      permissionRestoredCount: permissionResult.restoredCount,
      ruleAction,
    };
  }

  const permissionResult = await restorePermissionFallbacks(guild, permissionFallbacks);

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
      mode: "automod",
      permissionFallbacks: permissionResult.permissionFallbacks,
      permissionAppliedCount: 0,
      permissionRestoredCount: permissionResult.restoredCount,
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
    mode: "automod",
    permissionFallbacks: permissionResult.permissionFallbacks,
    permissionAppliedCount: 0,
    permissionRestoredCount: permissionResult.restoredCount,
    ruleAction: "created",
  };
}

async function saveGuildBlockedChannels(config, guildId, blockedChannelIds, permissionFallbacks = {}) {
  const normalizedFallbacks = Object.fromEntries(
    Object.entries(permissionFallbacks)
      .filter(([channelId, state]) => SNOWFLAKE_RE.test(channelId) && PERMISSION_FALLBACK_STATES.has(state)),
  );

  if (blockedChannelIds.length === 0 && Object.keys(normalizedFallbacks).length === 0) {
    delete config.guilds[guildId];
  } else {
    config.guilds[guildId] = { blockedChannelIds, permissionFallbacks: normalizedFallbacks };
  }

  await writeConfig(config);
}

function formatChannelList(channelIds, permissionFallbackCount = 0) {
  if (channelIds.length === 0) {
    return "현재 역할 멘션 차단 대상 채널이 없습니다.";
  }

  return [
    "현재 역할 멘션 차단 대상 채널입니다.",
    "",
    ...channelIds.map((channelId) => `- <#${channelId}> (${channelId})`),
    ...(permissionFallbackCount > 0
      ? ["", `Ticket Tool 대응용 채널 권한 fallback 적용: ${permissionFallbackCount}개`]
      : []),
  ].join("\n");
}

function formatChannelMentions(channelIds) {
  const shownChannelIds = channelIds.slice(0, 12);
  const remainingCount = channelIds.length - shownChannelIds.length;
  const suffix = remainingCount > 0 ? ` 외 ${remainingCount}개` : "";

  return `${shownChannelIds.map((channelId) => `<#${channelId}>`).join(", ")}${suffix}`;
}

function formatSyncResultLines(result) {
  if (result.mode === "channel-permissions") {
    return [
      "적용 방식: 채널 권한 fallback",
      "Ticket Tool 등으로 채널이 계속 늘어나 AutoMod 예외 채널 50개 제한을 넘었습니다.",
      `AutoMod 규칙: ${translateRuleAction(result.ruleAction)}`,
      `권한 fallback 적용 채널 수: ${Object.keys(result.permissionFallbacks).length}`,
      `현재 차단 대상 채널 수: ${result.blockedChannelIds.length}`,
      `AutoMod 제외 채널 수: ${result.exemptChannelCount}/${MAX_EXEMPT_CHANNELS}`,
      `AutoMod 발송 전 차단을 다시 쓰려면 차단 대상 채널을 최소 ${result.minimumBlockedChannelCount}개로 늘려야 합니다.`,
    ];
  }

  return [
    "적용 방식: AutoMod 발송 전 차단",
    `AutoMod 규칙: ${translateRuleAction(result.ruleAction)}`,
    `현재 차단 대상 채널 수: ${result.blockedChannelIds.length}`,
    `제외 채널 수: ${result.exemptChannelCount}/${MAX_EXEMPT_CHANNELS}`,
  ];
}

async function handleBlock(interaction) {
  const channelIds = parseChannelIds(interaction.options.getString("채널id", true));

  const channels = await fetchTargetChannels(interaction.guild, channelIds);
  const config = await readConfig();
  const guildConfig = ensureGuildConfig(config, interaction.guildId);
  const targetChannelIds = channels.map((channel) => channel.id);
  const requestedBlockedIds = uniqueSnowflakes([...guildConfig.blockedChannelIds, ...targetChannelIds]);
  const result = await syncAutoModRule(
    interaction.guild,
    requestedBlockedIds,
    guildConfig.permissionFallbacks,
  );

  await saveGuildBlockedChannels(
    config,
    interaction.guildId,
    result.blockedChannelIds,
    result.permissionFallbacks,
  );
  await interaction.editReply({
    content: [
      `${formatChannelMentions(targetChannelIds)} 채널에서 역할 멘션을 발송 전에 차단합니다.`,
      ...formatSyncResultLines(result),
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
  const result = await syncAutoModRule(
    interaction.guild,
    requestedBlockedIds,
    guildConfig.permissionFallbacks,
  );

  await saveGuildBlockedChannels(
    config,
    interaction.guildId,
    result.blockedChannelIds,
    result.permissionFallbacks,
  );
  await interaction.editReply({
    content: [
      `${formatChannelMentions(channelIds)} 채널의 역할 멘션 발송 전 차단을 해제했습니다.`,
      ...formatSyncResultLines(result),
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

async function handleList(interaction) {
  const config = await readConfig();
  const guildConfig = config.guilds[interaction.guildId] ?? {
    blockedChannelIds: [],
    permissionFallbacks: {},
  };

  await interaction.editReply({
    content: formatChannelList(
      guildConfig.blockedChannelIds,
      Object.keys(guildConfig.permissionFallbacks).length,
    ),
    allowedMentions: { parse: [] },
  });
}

async function handleReset(interaction) {
  const config = await readConfig();
  const guildConfig = ensureGuildConfig(config, interaction.guildId);
  const hadSavedConfig =
    guildConfig.blockedChannelIds.length > 0 || Object.keys(guildConfig.permissionFallbacks).length > 0;
  const permissionResult = await restorePermissionFallbacks(
    interaction.guild,
    guildConfig.permissionFallbacks,
  );
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
      `권한 fallback 복구 채널: ${permissionResult.restoredCount}개`,
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
  const guildConfig = config.guilds[guildId];

  if (!guildConfig) {
    return;
  }

  const blockedChannelIds = guildConfig.blockedChannelIds ?? [];
  const permissionFallbacks = guildConfig.permissionFallbacks ?? {};

  if (blockedChannelIds.length === 0 && Object.keys(permissionFallbacks).length === 0) {
    return;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);

  if (!guild) {
    return;
  }

  const result = await syncAutoModRule(guild, blockedChannelIds, permissionFallbacks);
  await saveGuildBlockedChannels(config, guildId, result.blockedChannelIds, result.permissionFallbacks);
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

