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
  Events
} = require('discord.js');

const db = require('./database');
const { initWallet, generateAddress } = require('./wallet');
const { checkPayment } = require('./blockchain');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

initWallet(process.env.BOT_MNEMONIC);

function calculateFee(amount) {
  if (amount <= 5) return 0;
  if (amount <= 10) return 0.3;
  if (amount <= 50) return 0.7;
  if (amount <= 100) return 1;
  if (amount > 250) return 2;
  return 0;
}

function log(guild, message) {
  const row = db.prepare(`SELECT value FROM config WHERE key='logChannel'`).get();
  if (!row) return;
  const channel = guild.channels.cache.get(row.value);
  if (channel) channel.send(message);
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {

  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'logchannel') {
      const id = interaction.options.getString('channelid');
      db.prepare(`INSERT OR REPLACE INTO config(key,value) VALUES('logChannel',?)`).run(id);
      return interaction.reply({ content: `Log channel set.`, flags: 64 });
    }

    if (interaction.commandName === 'autoticketpanel') {
      const embed = new EmbedBuilder()
        .setTitle("Litecoin Auto MM")
        .setDescription("Click below to start a trade.")
        .setColor("Green");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("start_trade")
          .setLabel("Start Trade")
          .setStyle(ButtonStyle.Primary)
      );

      return interaction.reply({ embeds: [embed], components: [row] });
    }
  }

  if (interaction.isButton()) {

    if (interaction.customId === "start_trade") {
      const modal = new ModalBuilder()
        .setCustomId("trade_modal")
        .setTitle("Start Trade");

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("otherUser")
            .setLabel("Other User ID")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel("Trade Amount (LTC)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );

      return interaction.showModal(modal);
    }
  }

  if (interaction.isModalSubmit()) {

    if (interaction.customId === "trade_modal") {

      const otherUserId = interaction.fields.getTextInputValue("otherUser");
      const amount = parseFloat(interaction.fields.getTextInputValue("amount"));

      if (isNaN(amount)) {
        return interaction.reply({ content: "Invalid amount.", flags: 64 });
      }

      const fee = calculateFee(amount);
      const total = amount + fee;

      const tradeIndex = db.prepare(`SELECT COUNT(*) as count FROM trades`).get().count;
      const wallet = generateAddress(tradeIndex);

      const channel = await interaction.guild.channels.create({
        name: `trade-${Date.now()}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
          { id: otherUserId, allow: [PermissionsBitField.Flags.ViewChannel] }
        ]
      });

      db.prepare(`
        INSERT INTO trades(channelId,senderId,receiverId,amount,fee,depositAddress,status)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        channel.id,
        interaction.user.id,
        otherUserId,
        amount,
        fee,
        wallet.address,
        "pending"
      );

      const embed = new EmbedBuilder()
        .setTitle("Trade Created")
        .setDescription(
          `Deposit Address:\n\`${wallet.address}\`\n\n` +
          `Amount: ${amount} LTC\n` +
          `Fee: ${fee} LTC\n` +
          `Total To Send: ${total} LTC`
        )
        .setColor("Blue");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("release")
          .setLabel("Release")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("refund")
          .setLabel("Refund")
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: `Trade channel created: ${channel}`, flags: 64 });

      log(interaction.guild, `Trade created: ${channel.id}`);

      // Auto payment monitor
      const interval = setInterval(async () => {
        const paid = await checkPayment(wallet.address, total);
        if (paid) {
          clearInterval(interval);
          db.prepare(`UPDATE trades SET status='paid' WHERE channelId=?`).run(channel.id);
          channel.send("Payment detected and confirmed.");
          log(interaction.guild, `Payment confirmed in ${channel.id}`);
        }
      }, 30000);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
