require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, Events, PermissionsBitField, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./trades.db');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const OWNER_ID = '1298640383688970293';
const TOKEN = process.env.DISCORD_TOKEN;
const MNEMONIC = process.env.BOT_MNEMONIC;

if (!TOKEN) {
  console.error('DISCORD_TOKEN missing');
  process.exit(1);
}

// Litecoin wallet
let root;
if (MNEMONIC) {
  const bip39 = require('bip39');
  const bitcoin = require('bitcoinjs-lib');
  const { ECPairFactory } = require('ecpair');
  const tinysecp = require('tiny-secp256k1');

  const ecc = tinysecp;
  const ECPair = ECPairFactory(ecc);

  const seed = bip39.mnemonicToSeedSync(MNEMONIC);
  const ltcNet = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019da4e8 },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
  };
  root = bitcoin.bip32.fromSeed(seed, ltcNet);
  const testAddr = getDepositAddress(0);
  console.log('LTC #0:', testAddr);
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
  db.run(`CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, buyer_id TEXT, currency TEXT, deposit_addr TEXT, channel_id TEXT, status TEXT DEFAULT 'waiting_role')`);
});

// Persistent panel
const panelView = new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder()
    .setCustomId('crypto_select')
    .setPlaceholder('Make a selection')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Bitcoin').setEmoji('🟠').setValue('BTC'),
      new StringSelectMenuOptionBuilder().setLabel('Ethereum').setEmoji('💎').setValue('ETH'),
      new StringSelectMenuOptionBuilder().setLabel('Litecoin').setEmoji('🔷').setValue('LTC'),
      new StringSelectMenuOptionBuilder().setLabel('Solana').setEmoji('☀️').setValue('SOL'),
      new StringSelectMenuOptionBuilder().setLabel('USDT [ERC-20]').setEmoji('💵').setValue('USDT_ERC20'),
      new StringSelectMenuOptionBuilder().setLabel('USDC [ERC-20]').setEmoji('💵').setValue('USDC_ERC20'),
      new StringSelectMenuOptionBuilder().setLabel('USDT [SOL]').setEmoji('💵').setValue('USDT_SOL'),
      new StringSelectMenuOptionBuilder().setLabel('USDC [SOL]').setEmoji('💵').setValue('USDC_SOL'),
      new StringSelectMenuOptionBuilder().setLabel('USDT [BEP-20]').setEmoji('💵').setValue('USDT_BEP20')
    )
);

// Modal
const tradeModal = (currency) => new ModalBuilder()
  .setCustomId(`trade_modal_${currency}`)
  .setTitle('Trade Setup')
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

// Role buttons
const roleRow = (tradeId, starterId, otherId) => new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(`sender_${tradeId}`)
    .setLabel('Sender')
    .setStyle(ButtonStyle.Success),
  new ButtonBuilder()
    .setCustomId(`receiver_${tradeId}`)
    .setLabel('Receiver')
    .setStyle(ButtonStyle.Primary)
);

// Interaction handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isCommand() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit() && !interaction.isButton()) return;

  // Commands
  if (interaction.isCommand()) {
    const { commandName } = interaction;

    if (commandName === 'generatekey') {
      if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'No.', ephemeral: true });
      const key = Math.random().toString(36).substring(2, 18).toUpperCase();
      db.run('INSERT INTO keys (key) VALUES (?)', key);
      await interaction.reply({ content: `Key: \`${key}\``, ephemeral: true });
    }

    if (commandName === 'redeemkey') {
      if (interaction.user.id === OWNER_ID) return interaction.reply({ content: "Owner doesn't need key.", ephemeral: true });
      const key = interaction.options.getString('key').toUpperCase();
      db.get('SELECT used FROM keys WHERE key = ?', key, (err, row) => {
        if (err || !row || row.used) return interaction.reply({ content: 'Invalid/used.', ephemeral: true });
        db.run('UPDATE keys SET used = 1 WHERE key = ?', key);
        db.run('INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)', interaction.user.id);
        interaction.reply({ content: 'Activated.', ephemeral: true });
      });
    }

    if (commandName === 'autoticketpanel') {
      if (interaction.user.id !== OWNER_ID) {
        db.get('SELECT 1 FROM activated_users WHERE user_id = ?', interaction.user.id, (err, row) => {
          if (!row) return interaction.reply({ content: 'Redeem a key first.', ephemeral: true });
          interaction.reply({ embeds: [new EmbedBuilder().setTitle('Crypto Currency').setDescription('**Fees:**\n• >250$: 2$\n• <250$: 1$\n• <50$: 0.7$\n• <10$: 0.3$\n• <5$: FREE')], components: [panelView] });
        });
      } else {
        interaction.reply({ embeds: [new EmbedBuilder().setTitle('Crypto Currency').setDescription('**Fees:**\n• >250$: 2$\n• <250$: 1$\n• <50$: 0.7$\n• <10$: 0.3$\n• <5$: FREE')], components: [panelView] });
      }
    }
  }

  // Select menu
  if (interaction.isStringSelectMenu() && interaction.customId === 'crypto_select') {
    const currency = interaction.values[0];
    await interaction.showModal(tradeModal(currency));
  }

  // Modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith('trade_modal_')) {
    const currency = interaction.customId.split('_')[2];
    const otherInput = interaction.fields.getTextInputValue('other_user');
    const youGive = interaction.fields.getTextInputValue('you_give');
    const theyGive = interaction.fields.getTextInputValue('they_give');

    let otherUser;
    try {
      const id = otherInput.replace(/[<@!>]/g, '');
      otherUser = await client.users.fetch(id);
    } catch {
      return interaction.reply({ content: 'Invalid user ID/mention.', ephemeral: true });
    }

    if (otherUser.id === interaction.user.id) return interaction.reply({ content: "Can't trade with yourself.", ephemeral: true });

    const idx = Date.now() % 1000000;
    const addr = get_addr(idx);

    db.run(
      'INSERT INTO trades (buyer_id, currency, deposit_addr, channel_id, status) VALUES (?, ?, ?, ?, ?)',
      [interaction.user.id, currency, addr, 'pending', 'waiting_role'],
      function(err) {
        if (err) return interaction.reply({ content: 'DB error.', ephemeral: true });
        const tradeId = this.lastID;

        const overwrites = {
          [interaction.guild.roles.everyone.id]: { ViewChannel: false },
          [interaction.user.id]: { ViewChannel: true, SendMessages: true },
          [otherUser.id]: { ViewChannel: true, SendMessages: true }
        };

        interaction.guild.channels.create({
          name: `trade-${tradeId}`,
          type: 0,
          permission_overwrites: overwrites
        }).then(ch => {
          db.run('UPDATE trades SET channel_id = ? WHERE id = ?', [ch.id, tradeId]);

          const embed = new EmbedBuilder()
            .setTitle(`Trade #${tradeId}`)
            .setDescription(`**Currency:** ${currency}\n**Deposit:** \`${addr}\`\n${interaction.user} gives: ${youGive}\n${otherUser} gives: ${theyGive}`)
            .setColor('#00ff00');

          ch.send({ content: `${otherUser}, pick your role:`, embeds: [embed], components: [roleRow(tradeId, interaction.user.id, otherUser.id)] });

          interaction.reply({ content: `Ticket created: ${ch}`, ephemeral: true });
        }).catch(err => {
          console.error('Channel create error:', err);
          interaction.reply({ content: 'Failed to create channel (check permissions).', ephemeral: true });
        });
      }
    );
  }

  // Buttons
  if (interaction.isButton() && interaction.customId.startsWith('sender_') || interaction.customId.startsWith('receiver_')) {
    const [role, tradeId] = interaction.customId.split('_');
    const isSender = role === 'sender';

    db.get('SELECT buyer_id FROM trades WHERE id = ?', tradeId, (err, row) => {
      if (err || !row) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

      if (interaction.user.id === row.buyer_id) return interaction.reply({ content: 'Buyer cannot choose role.', ephemeral: true });

      db.run('UPDATE trades SET status = ? WHERE id = ?', [isSender ? 'sender' : 'receiver', tradeId]);
      interaction.update({ content: `${interaction.user} chose **${isSender ? 'Sender' : 'Receiver'}**`, components: [] });
    });
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);
