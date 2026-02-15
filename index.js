require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionsBitField, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { initWallet, getDepositAddress } = require('./wallet'); // <--- NEW IMPORT

const db = new sqlite3.Database('./trades.db');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const OWNER_ID = '1298640383688970293';
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_LTC_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
const FEE_USD = 0.3;
const CURRENCY = 'LTC';

if (!TOKEN) {
  console.error('DISCORD_TOKEN missing');
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Initialize wallet on startup
initWallet(process.env.BOT_MNEMONIC);

// DB setup
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS activated_users (user_id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id TEXT,
    seller_id TEXT,
    currency TEXT DEFAULT 'LTC',
    deposit_addr TEXT,
    amount REAL,
    fee REAL DEFAULT ${FEE_USD},
    status TEXT DEFAULT 'waiting_role',
    channel_id TEXT,
    sender_chosen INTEGER DEFAULT 0,
    receiver_chosen INTEGER DEFAULT 0,
    confirmed INTEGER DEFAULT 0,
    receiver_address TEXT,
    close_votes INTEGER DEFAULT 0
  )`);
});

// Litecoin panel
const ltcEmbed = new EmbedBuilder()
  .setTitle('Litecoin Escrow')
  .setDescription('**Fees:**\n• Deals over 250$: **2$**\n• Deals under 250$: **1$**\n• Deals under 50$: **0.7$**\n• Deals under 10$: **0.3$**\n• Deals under 5$: **FREE**')
  .setColor('#00aaff');

const startButtonRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId('start_ltc_trade')
    .setLabel('Start LTC Trade')
    .setStyle(ButtonStyle.Primary)
);

// Commands & interactions (rest of your bot logic remains the same)
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isCommand()) {
    const { commandName } = interaction;

    if (commandName === 'generatekey') {
      if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Only owner.', ephemeral: true });
      const key = Math.random().toString(36).substring(2, 18).toUpperCase();
      db.run('INSERT INTO keys (key) VALUES (?)', key);
      await interaction.reply({ content: `Key: \`${key}\``, ephemeral: true });
    }

    if (commandName === 'redeemkey') {
      const key = interaction.options.getString('key').toUpperCase();
      if (interaction.user.id === OWNER_ID) return interaction.reply({ content: "Owner doesn't need key.", ephemeral: true });

      db.get('SELECT used FROM keys WHERE key = ?', key, (err, row) => {
        if (err || !row || row.used) return interaction.reply({ content: 'Invalid/used.', ephemeral: true });
        db.run('UPDATE keys SET used = 1 WHERE key = ?', key);
        db.run('INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)', interaction.user.id);
        interaction.reply({ content: 'Activated!', ephemeral: true });
      });
    }

    if (commandName === 'autoticketpanel') {
      db.get('SELECT 1 FROM activated_users WHERE user_id = ?', interaction.user.id, (err, row) => {
        if (interaction.user.id !== OWNER_ID && !row) return interaction.reply({ content: 'Redeem a key first.', ephemeral: true });

        interaction.reply({ embeds: [ltcEmbed], components: [startButtonRow] });
      });
    }

    if (commandName === 'close') {
      if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Only owner can close.', ephemeral: true });
      if (!interaction.channel.name.startsWith('trade-')) return interaction.reply({ content: 'Not a trade channel.', ephemeral: true });

      await interaction.channel.delete();
      interaction.reply({ content: 'Ticket closed by owner.', ephemeral: true });
    }
  }

  if (interaction.isButton() && interaction.customId === 'start_ltc_trade') {
    const modal = new ModalBuilder()
      .setCustomId('trade_modal_ltc')
      .setTitle('Litecoin Trade Setup')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('other_user')
            .setLabel('User/ID of the other person')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('@mention or ID')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('you_give')
            .setLabel('What are YOU giving')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('they_give')
            .setLabel('What are THEY giving')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        )
      );

    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'trade_modal_ltc') {
    const otherInput = interaction.fields.getTextInputValue('other_user');
    const youGive = interaction.fields.getTextInputValue('you_give');
    const theyGive = interaction.fields.getTextInputValue('they_give');

    let otherUser;
    try {
      const id = otherInput.replace(/[<@!>]/g, '');
      otherUser = await client.users.fetch(id);
    } catch (err) {
      return interaction.reply({ content: 'Invalid user ID/mention.', ephemeral: true });
    }

    if (otherUser.id === interaction.user.id) return interaction.reply({ content: "Can't trade with yourself.", ephemeral: true });

    const idx = Date.now() % 1000000;
    const addr = getDepositAddress(idx);

    db.run(
      'INSERT INTO trades (buyer_id, currency, deposit_addr, channel_id, status) VALUES (?, ?, ?, ?, ?)',
      [interaction.user.id, CURRENCY, addr, 'pending', 'waiting_role'],
      function(err) {
        if (err) return interaction.reply({ content: 'DB error.', ephemeral: true });
        const tradeId = this.lastID;

        const overwrites = [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: otherUser.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ];

        interaction.guild.channels.create({
          name: `trade-${tradeId}`,
          type: ChannelType.GuildText,
          permission_overwrites: overwrites
        }).then(ch => {
          db.run('UPDATE trades SET channel_id = ? WHERE id = ?', [ch.id, tradeId]);

          const embed = new EmbedBuilder()
            .setTitle(`Litecoin Trade #${tradeId}`)
            .setDescription(`**Deposit:** \`${addr}\`\n${interaction.user} gives: ${youGive}\n${otherUser} gives: ${theyGive}`)
            .setColor('#00aaff');

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`choose_role_${tradeId}_sender`)
              .setLabel('Sender')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`choose_role_${tradeId}_receiver`)
              .setLabel('Receiver')
              .setStyle(ButtonStyle.Primary)
          );

          ch.send({ content: `${interaction.user} started LTC trade with ${otherUser}.\nBoth can choose role:`, embeds: [embed], components: [row] });

          interaction.reply({ content: `Litecoin ticket created: ${ch}`, ephemeral: true });
        }).catch(err => {
          console.error('Channel create error:', err);
          interaction.reply({ content: 'Failed to create channel (bot needs Manage Channels permission).', ephemeral: true });
        });
      }
    );
  }

  // Button handler (same as before)
  if (interaction.isButton()) {
    const [action, tradeId, role] = interaction.customId.split('_');

    if (action === 'choose_role') {
      db.get('SELECT sender_chosen, receiver_chosen FROM trades WHERE id = ?', tradeId, (err, row) => {
        if (err || !row) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        const isSender = role === 'sender';

        db.run(`UPDATE trades SET ${isSender ? 'sender_chosen' : 'receiver_chosen'} = 1 WHERE id = ?`, tradeId);

        interaction.update({ content: `${interaction.user} chose **${isSender ? 'Sender' : 'Receiver'}**`, components: interaction.message.components });

        db.get('SELECT sender_chosen, receiver_chosen FROM trades WHERE id = ?', tradeId, (err, r) => {
          if (r.sender_chosen && r.receiver_chosen) {
            const confirmRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`confirm_trade_${tradeId}`).setLabel('Confirm trade').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`cancel_trade_${tradeId}`).setLabel('Not Confirmed').setStyle(ButtonStyle.Danger)
            );

            interaction.channel.send({ content: 'Both roles chosen. Confirm trade?', components: [confirmRow] });
          }
        });
      });
    }

    // ... (rest of your button logic for confirm_trade, input_amount, refund, release, close_yes/close_no remains unchanged)
    // Copy it from your previous version if you want to keep the full flow
  }
});

client.once(Events.ClientReady, () => {
  log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);
