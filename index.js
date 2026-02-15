require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionsBitField,
  Events,
  SlashCommandBuilder,
  Routes,
} = require('discord.js');

const db = require('./database');
const { initWallet, generateAddress } = require('./wallet');
const { checkPayment } = require('./blockchain');
const { REST } = require('@discordjs/rest');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Bot config
const OWNER_ID = process.env.OWNER_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

initWallet(process.env.BOT_MNEMONIC);

// ---------- Register Slash Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('autoticketpanel')
    .setDescription('Show the auto trade panel'),
  new SlashCommandBuilder()
    .setName('logchannel')
    .setDescription('Set a log channel')
    .addStringOption((opt) =>
      opt.setName('channelid').setDescription('Channel ID').setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Refreshing slash commands...');
    await rest.put(Routes.applicationCommands(client.user?.id || '0'), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error(err);
  }
})();

// ---------- Utilities ----------
function calculateFee(amount) {
  if (amount <= 5) return 0;
  if (amount <= 10) return 0.3;
  if (amount <= 50) return 0.7;
  if (amount <= 100) return 1;
  if (amount > 250) return 2;
  return 0;
}

function log(guild, msg) {
  const row = db.prepare(`SELECT value FROM config WHERE key='logChannel'`).get();
  if (!row) return;
  const ch = guild.channels.cache.get(row.value);
  if (ch) ch.send(msg);
}

// ---------- Client Ready ----------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------- Interactions ----------
client.on(Events.InteractionCreate, async (interaction) => {
  // ----- Slash commands -----
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'logchannel') {
      if (interaction.user.id !== OWNER_ID)
        return interaction.reply({ content: 'Only owner.', flags: 64 });

      const id = interaction.options.getString('channelid');
      db.prepare(
        `INSERT OR REPLACE INTO config(key,value) VALUES('logChannel',?)`
      ).run(id);
      return interaction.reply({ content: 'Log channel set.', flags: 64 });
    }

    if (commandName === 'autoticketpanel') {
      const embed = new EmbedBuilder()
        .setTitle('USD Auto MM Panel')
        .setDescription('Click below to start a trade.')
        .setColor('Green');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_trade')
          .setLabel('Start Trade')
          .setStyle(ButtonStyle.Primary)
      );

      return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
    }
  }

  // ----- Button Interactions -----
  if (interaction.isButton()) {
    // Start trade modal
    if (interaction.customId === 'start_trade') {
      const modal = new ModalBuilder()
        .setCustomId('trade_modal')
        .setTitle('Start Trade');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('otherUser')
            .setLabel('Other User ID')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('youGive')
            .setLabel('What YOU give')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('theyGive')
            .setLabel('What THEY give')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        )
      );

      return interaction.showModal(modal);
    }

    // Sender/Receiver selection (just flags)
    if (interaction.customId.startsWith('choose_role_')) {
      const [_, tradeId, role] = interaction.customId.split('_');
      const isSender = role === 'sender';

      db.prepare(
        `UPDATE trades SET ${isSender ? 'senderChosen' : 'receiverChosen'}=1 WHERE id=?`
      ).run(tradeId);

      return interaction.update({
        content: `${interaction.user} chose ${role}`,
        components: interaction.message.components,
      });
    }
  }

  // ----- Modal submit -----
  if (interaction.isModalSubmit() && interaction.customId === 'trade_modal') {
    const otherUserId = interaction.fields.getTextInputValue('otherUser');
    const youGive = interaction.fields.getTextInputValue('youGive');
    const theyGive = interaction.fields.getTextInputValue('theyGive');

    const tradeIndex = db.prepare(`SELECT COUNT(*) as count FROM trades`).get().count;
    const depositAddress = generateAddress(tradeIndex);

    // Create trade ticket channel
    const channel = await interaction.guild.channels.create({
      name: `trade-${Date.now()}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: otherUserId, allow: [PermissionsBitField.Flags.ViewChannel] },
      ],
    });

    db.prepare(
      `INSERT INTO trades(channelId,senderId,receiverId,youGive,theyGive,depositAddress,status) VALUES(?,?,?,?,?,?,?)`
    ).run(channel.id, interaction.user.id, otherUserId, youGive, theyGive, depositAddress, 'waiting');

    const embed = new EmbedBuilder()
      .setTitle('Trade Created')
      .setDescription(
        `Deposit Address:\n\`${depositAddress}\`\n\n` +
          `You give: ${youGive}\n` +
          `They give: ${theyGive}\n` +
          `Amount: $0 (set by sender)\n` +
          `Fee: $0`
      )
      .setColor('Blue');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`choose_role_${tradeIndex}_sender`)
        .setLabel('Sender')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`choose_role_${tradeIndex}_receiver`)
        .setLabel('Receiver')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({
      content: `Trade started by <@${interaction.user.id}>`,
      embeds: [embed],
      components: [row],
    });

    await interaction.reply({
      content: `Trade channel created: ${channel}`,
      flags: 64,
    });

    log(interaction.guild, `Trade created: ${channel.id}`);
  }
});

// ---------- Login ----------
client.login(DISCORD_TOKEN);
