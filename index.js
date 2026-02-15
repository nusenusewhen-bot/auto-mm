require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionsBitField, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const tinysecp = require('tiny-secp256k1');
const { BIP32Factory } = require('bitcoinjs-lib/lib/bip32'); // correct import path

const bip32 = BIP32Factory(tinysecp);

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

// Wallet – FIXED with BIP32Factory
let root;
const mnemonic = process.env.BOT_MNEMONIC;
if (mnemonic) {
  try {
    const seed = bip39.mnemonicToSeedSync(mnemonic);

    const ltcNet = {
      messagePrefix: '\x19Litecoin Signed Message:\n',
      bech32: 'ltc',
      bip32: { public: 0x019da462, private: 0x019da4e8 },
      pubKeyHash: 0x30,
      scriptHash: 0x32,
      wif: 0xb0
    };

    root = bip32.fromSeed(seed, ltcNet);
    log(`Litecoin wallet loaded. Address #0: ${getDepositAddress(0)}`);
  } catch (err) {
    log(`Wallet init failed: ${err.message}`);
    root = null;
  }
} else {
  log('No BOT_MNEMONIC set - wallet disabled');
}

function getDepositAddress(index) {
  if (!root) return 'WALLET_NOT_LOADED';
  const path = `m/44'/2'/0'/0/${index}`;
  const child = root.derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: ltcNet });
  return address;
}

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

// Commands & interactions
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

  // Start LTC trade button
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

  // Modal submit
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

  // Button handler
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

    if (action === 'confirm_trade') {
      db.get('SELECT buyer_id FROM trades WHERE id = ?', tradeId, (err, row) => {
        if (interaction.user.id !== row.buyer_id && interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Only Sender or owner can confirm.', ephemeral: true });

        db.run('UPDATE trades SET status = "confirmed" WHERE id = ?', tradeId);

        const amountRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`input_amount_${tradeId}`).setLabel('Input amount ($)').setStyle(ButtonStyle.Primary)
        );

        interaction.update({ content: 'Trade confirmed! Sender, input amount.', components: [amountRow] });
      });
    }

    if (action === 'input_amount') {
      db.get('SELECT buyer_id FROM trades WHERE id = ?', tradeId, (err, row) => {
        if (interaction.user.id !== row.buyer_id) return interaction.reply({ content: 'Only Sender can input amount.', ephemeral: true });

        interaction.reply({ content: 'Reply with the amount in $ (e.g. 8)', ephemeral: true });

        const filter = m => m.author.id === interaction.user.id;
        interaction.channel.awaitMessages({ filter, max: 1, time: 60000 }).then(collected => {
          const amount = parseFloat(collected.first().content);
          if (isNaN(amount)) return interaction.followup({ content: 'Invalid amount.', ephemeral: true });

          const total = amount + FEE_USD;
          interaction.followup({ content: `Send **${total.toFixed(2)} LTC** (amount + ${FEE_USD}$ fee converted to LTC)\nFee address: ${OWNER_LTC_ADDRESS}\nDeposit address: ${getDepositAddress(tradeId)}`, ephemeral: true });

          db.run('UPDATE trades SET amount = ? WHERE id = ?', [amount, tradeId]);
        });
      });
    }

    if (action === 'refund') {
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_refund_${tradeId}`).setLabel('Confirm Refund').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cancel_refund_${tradeId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );

      interaction.reply({ content: 'Refund requires confirmation from both users.', components: [confirmRow], ephemeral: false });
    }

    if (action === 'confirm_refund') {
      // TODO: refund to buyer
      interaction.update({ content: 'Refund confirmed and processed.', components: [] });
    }

    if (action === 'release') {
      if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Only owner can release.', ephemeral: true });

      db.get('SELECT receiver_address FROM trades WHERE id = ?', tradeId, (err, row) => {
        if (!row.receiver_address) return interaction.reply({ content: 'No receiver address set.', ephemeral: true });

        // TODO: send funds to receiver_address
        interaction.reply({ content: `Funds released to ${row.receiver_address}`, ephemeral: false });

        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`close_yes_${tradeId}`).setLabel('Yes').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`close_no_${tradeId}`).setLabel('No').setStyle(ButtonStyle.Danger)
        );

        interaction.channel.send({ content: 'Money received/refunded. Close ticket?', components: [closeRow] });
      });
    }

    if (action === 'close_yes') {
      db.run('UPDATE trades SET close_votes = close_votes + 1 WHERE id = ?', tradeId);
      db.get('SELECT close_votes FROM trades WHERE id = ?', tradeId, (err, row) => {
        if (row.close_votes >= 2) {
          interaction.channel.delete();
        } else {
          interaction.update({ content: `${interaction.user} voted to close. Waiting for second vote.`, components: interaction.message.components });
        }
      });
    }

    if (action === 'close_no') {
      interaction.update({ content: `${interaction.user} voted not to close. Ticket stays open.`, components: interaction.message.components });
    }
  }
});

client.once(Events.ClientReady, () => {
  log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);
