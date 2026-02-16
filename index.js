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
  MessageFlags,
} = require('discord.js');

const db = require('./database');
const { initWallet, generateAddress, sendLTC, getWalletBalance, sendAllLTC, isInitialized, getBalanceAtIndex, sendFeeToAddress } = require('./wallet');
const { checkPayment, getLtcPriceUSD, checkTransactionMempool, getAddressUTXOs } = require('./blockchain');
const { REST } = require('@discordjs/rest');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const OWNER_ID = process.env.OWNER_ID;
const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';

// Track confirmed interactions to prevent double-clicks
const confirmedInteractions = new Set();
const activeMonitors = new Map();

if (!DISCORD_TOKEN || !OWNER_ID || !process.env.BOT_MNEMONIC) {
  console.error('Missing required environment variables. Check your .env file.');
  process.exit(1);
}

const walletInitialized = initWallet(process.env.BOT_MNEMONIC);
if (!walletInitialized) {
  console.error('Failed to initialize wallet. Check your BOT_MNEMONIC in .env');
  process.exit(1);
}

async function hasOwnerPermissions(userId, member) {
  if (userId === OWNER_ID) return true;
  if (OWNER_ROLE_ID && member) {
    return member.roles.cache.has(OWNER_ROLE_ID);
  }
  return false;
}

function calculateFee(amount, feePercent = 5) {
  return (amount * feePercent) / 100;
}

async function getFeePercent() {
  const row = db.prepare("SELECT value FROM config WHERE key='feePercent'").get();
  return row ? parseFloat(row.value) : 5;
}

const commands = [
  new SlashCommandBuilder()
    .setName('mmz')
    .setDescription('Start a middleman trade (Owner only)')
    .addUserOption(opt => opt.setName('user1').setDescription('First user').setRequired(true))
    .addUserOption(opt => opt.setName('user2').setDescription('Second user').setRequired(true))
    .addNumberOption(opt => opt.setName('amount').setDescription('USD amount').setRequired(true)),
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check wallet balance (Owner only)'),
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send all LTC to an address (Owner only)')
    .addStringOption(opt => opt.setName('address').setDescription('Litecoin address').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setfee')
    .setDescription('Set fee percentage (Owner only)')
    .addNumberOption(opt => opt.setName('percentage').setDescription('Fee %').setRequired(true)),
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket'),
].map(cmd => cmd.toJSON());

// Deploy commands
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  try {
    console.log('Deploying commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Commands deployed.');
  } catch (err) {
    console.error('Command deploy error:', err.message);
  }
  
  // Restart monitors for active trades
  const activeTrades = db.prepare("SELECT * FROM trades WHERE status IN ('awaiting_payment', 'awaiting_confirmation')").all();
  for (const trade of activeTrades) {
    if (trade.amount && trade.amount > 0) {
      startPaymentMonitor(trade.id, trade.channelId, trade.totalLtc);
    }
  }
});

// ==================== MAIN COMMAND HANDLER ====================

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash Commands
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    // Modals
    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
      return;
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'mmz') {
    await startMiddleman(interaction);
  } else if (commandName === 'balance') {
    await showBalance(interaction);
  } else if (commandName === 'send') {
    await handleSendCommand(interaction);
  } else if (commandName === 'setfee') {
    await setFeeCommand(interaction);
  } else if (commandName === 'close') {
    await closeTicket(interaction);
  }
}

// ==================== /MMZ COMMAND - START TRADE ====================

async function startMiddleman(interaction) {
  if (!await hasOwnerPermissions(interaction.user.id, interaction.member)) {
    return interaction.reply({ content: '❌ Only owners can use this.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user1 = interaction.options.getUser('user1');
  const user2 = interaction.options.getUser('user2');
  const amount = interaction.options.getNumber('amount');

  if (!user1 || !user2) {
    return interaction.editReply({ content: '❌ Please specify both users.' });
  }

  // Create private channel
  const channel = await interaction.guild.channels.create({
    name: `ltc-${user1.username}-${user2.username}`.substring(0, 100),
    type: ChannelType.GuildText,
    permissionOverwrites: [
      {
        id: interaction.guild.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: user1.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      },
      {
        id: user2.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      },
      {
        id: client.user.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      },
    ],
  });

  // Create trade in DB
  const result = db.prepare(`
    INSERT INTO trades (channelId, user1Id, user2Id, senderId, receiverId, amount, status, createdAt)
    VALUES (?, ?, ?, NULL, NULL, ?, 'role_selection', datetime('now'))
  `).run(channel.id, user1.id, user2.id, amount);

  const tradeId = result.lastInsertRowid;

  // Send initial embed (like video)
  const embed = new EmbedBuilder()
    .setTitle('👋 Malieno\'s Auto Middleman Service')
    .setDescription('Make sure to follow the steps and read the instructions thoroughly.\nPlease explicitly state the trade details if the information below is inaccurate.')
    .addFields(
      { name: `${user1.username}'s side:`, value: `$${amount}`, inline: true },
      { name: `${user2.username}'s side:`, value: 'Waiting...', inline: true }
    )
    .setColor(0x5865F2);

  const deleteRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`delete_ticket_${tradeId}`)
      .setLabel('Delete Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: `${user1} ${user2}`, embeds: [embed], components: [deleteRow] });

  // Send role selection (like video)
  const roleEmbed = new EmbedBuilder()
    .setDescription('**Select your role**\n• **"Sender"** if you are **Sending** LTC to the bot.\n• **"Receiver"** if you are **Receiving** LTC *later* from the bot.')
    .setColor(0x5865F2);

  const roleRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`role_sender_${tradeId}`)
      .setLabel('Sender')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_receiver_${tradeId}`)
      .setLabel('Receiver')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_reset_${tradeId}`)
      .setLabel('Reset')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({ embeds: [roleEmbed], components: [roleRow] });

  await interaction.editReply({ content: `✅ Trade channel created: ${channel}` });
}

// ==================== BUTTON HANDLER ====================

async function handleButton(interaction) {
  const customId = interaction.customId;
  
  // Prevent double clicks
  const interactionKey = `${interaction.user.id}_${customId}`;
  if (confirmedInteractions.has(interactionKey)) {
    return interaction.reply({ content: '⏳ Processing...', flags: MessageFlags.Ephemeral });
  }

  // Delete ticket
  if (customId.startsWith('delete_ticket_')) {
    await interaction.channel.delete();
    return;
  }

  // Role selection
  if (customId.startsWith('role_')) {
    await handleRoleSelection(interaction);
    return;
  }

  // Confirm info
  if (customId.startsWith('confirm_info_')) {
    await handleConfirmInfo(interaction);
    return;
  }

  // Incorrect info
  if (customId.startsWith('incorrect_info_')) {
    await interaction.reply({ content: '❌ Please state the correct trade details in chat.', ephemeral: false });
    return;
  }

  // Set USD amount
  if (customId.startsWith('set_amount_')) {
    await handleSetAmount(interaction);
    return;
  }

  // Confirm USD amount
  if (customId.startsWith('confirm_amount_')) {
    await handleConfirmAmount(interaction);
    return;
  }

  // Incorrect amount
  if (customId.startsWith('incorrect_amount_')) {
    await interaction.reply({ content: '❌ Please set the correct amount.', ephemeral: false });
    return;
  }

  // Release funds
  if (customId.startsWith('release_')) {
    await handleRelease(interaction);
    return;
  }

  // Confirm release (from the warning message)
  if (customId.startsWith('confirm_release_')) {
    const tradeId = customId.split('_')[2];
    await promptForAddress(interaction, tradeId);
    return;
  }

  // Back release
  if (customId.startsWith('back_release_')) {
    await interaction.update({ content: '❌ Release cancelled.', components: [], embeds: [] });
    return;
  }

  // Cancel trade
  if (customId.startsWith('cancel_trade_')) {
    await interaction.update({ content: '❌ Cancelled.', components: [], embeds: [] });
    return;
  }

  // Enter address
  if (customId.startsWith('enter_address_')) {
    const tradeId = customId.split('_')[2];
    
    const modal = new ModalBuilder()
      .setCustomId(`address_modal_${tradeId}`)
      .setTitle('Enter Your LTC Address');

    const addressInput = new TextInputBuilder()
      .setCustomId('ltc_address')
      .setLabel('LTC Address')
      .setPlaceholder('LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(addressInput));
    await interaction.showModal(modal);
    return;
  }

  // Confirm withdrawal address
  if (customId.startsWith('confirm_withdraw_')) {
    await handleConfirmWithdraw(interaction);
    return;
  }

  // Back button
  if (customId.startsWith('back_')) {
    const tradeId = customId.split('_')[1];
    await promptForAddress(interaction, tradeId);
    return;
  }

  // Close ticket
  if (customId === 'close_ticket') {
    await interaction.channel.delete();
    return;
  }

  // Copy details
  if (customId.startsWith('copy_details_')) {
    await interaction.reply({ content: '✅ Details copied to clipboard!', flags: MessageFlags.Ephemeral });
    return;
  }

  // Confirm sendall
  if (customId.startsWith('confirm_sendall_')) {
    const parts = interaction.customId.split('_');
    const address = parts[3];
    
    await interaction.update({ content: '⏳ Processing...', components: [], embeds: [] });

    const result = await sendAllLTC(address);
    
    if (result.success) {
      const embed = new EmbedBuilder()
        .setTitle('✅ Sent')
        .addFields(
          { name: 'Amount', value: result.amountSent || '?' },
          { name: 'To', value: address },
          { name: 'TxID', value: result.txid }
        )
        .setColor('Green');
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.editReply({ content: `❌ Failed: ${result.error}` });
    }
    return;
  }

  // Cancel sendall
  if (customId === 'cancel_sendall') {
    await interaction.update({ content: '❌ Cancelled.', components: [], embeds: [] });
    return;
  }
}

// ==================== ROLE SELECTION ====================

async function handleRoleSelection(interaction) {
  const parts = interaction.customId.split('_');
  const action = parts[1];
  const tradeId = parts[2];

  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (action === 'reset') {
    db.prepare('UPDATE trades SET senderId = NULL, receiverId = NULL WHERE id = ?').run(tradeId);
    await updateRoleDisplay(interaction, tradeId);
    return interaction.reply({ content: '✅ Roles reset.', flags: MessageFlags.Ephemeral });
  }

  const isSender = action === 'sender';
  const userId = interaction.user.id;

  if (userId !== trade.user1Id && userId !== trade.user2Id) {
    return interaction.reply({ content: '❌ You are not part of this trade.', flags: MessageFlags.Ephemeral });
  }

  if (isSender && trade.senderId === userId) {
    return interaction.reply({ content: '✅ You are already the Sender!', flags: MessageFlags.Ephemeral });
  }
  if (!isSender && trade.receiverId === userId) {
    return interaction.reply({ content: '✅ You are already the Receiver!', flags: MessageFlags.Ephemeral });
  }

  if (isSender && trade.receiverId === userId) {
    return interaction.reply({ content: '❌ You cannot be both Sender and Receiver!', flags: MessageFlags.Ephemeral });
  }
  if (!isSender && trade.senderId === userId) {
    return interaction.reply({ content: '❌ You cannot be both Sender and Receiver!', flags: MessageFlags.Ephemeral });
  }

  if (isSender) {
    db.prepare('UPDATE trades SET senderId = ? WHERE id = ?').run(userId, tradeId);
  } else {
    db.prepare('UPDATE trades SET receiverId = ? WHERE id = ?').run(userId, tradeId);
  }

  await interaction.reply({ content: `✅ You are now the ${isSender ? 'Sender' : 'Receiver'}!`, flags: MessageFlags.Ephemeral });

  await updateRoleDisplay(interaction, tradeId);

  const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (updated.senderId && updated.receiverId) {
    await sendInfoConfirmation(interaction.channel, tradeId);
  }
}

async function updateRoleDisplay(interaction, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  
  let description = '**Select your role**\n• **"Sender"** if you are **Sending** LTC to the bot.\n• **"Receiver"** if you are **Receiving** LTC *later* from the bot.\n\n';

  if (trade.senderId) {
    const sender = await client.users.fetch(trade.senderId).catch(() => null);
    description += `**Sender:** ${sender ? sender.toString() : 'Unknown'}\n`;
  }
  if (trade.receiverId) {
    const receiver = await client.users.fetch(trade.receiverId).catch(() => null);
    description += `**Receiver:** ${receiver ? receiver.toString() : 'Unknown'}\n`;
  }

  const embed = new EmbedBuilder().setDescription(description).setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`role_sender_${tradeId}`)
      .setLabel('Sender')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_receiver_${tradeId}`)
      .setLabel('Receiver')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_reset_${tradeId}`)
      .setLabel('Reset')
      .setStyle(ButtonStyle.Danger)
  );

  const messages = await interaction.channel.messages.fetch({ limit: 10 });
  const roleMsg = messages.find(m => m.embeds[0]?.description?.includes('Select your role'));
  if (roleMsg) {
    await roleMsg.edit({ embeds: [embed], components: [row] });
  }
}

// ==================== INFO CONFIRMATION ====================

async function sendInfoConfirmation(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const sender = await client.users.fetch(trade.senderId).catch(() => null);
  const receiver = await client.users.fetch(trade.receiverId).catch(() => null);

  const embed = new EmbedBuilder()
    .setTitle('• Is This Information Correct?')
    .addFields(
      { name: 'Sender', value: sender ? sender.toString() : 'Unknown', inline: false },
      { name: 'Receiver', value: receiver ? receiver.toString() : 'Unknown', inline: false }
    )
    .setDescription('Make sure you have selected the right role! If you didn\'t then click "Incorrect"')
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_info_${tradeId}`)
      .setLabel('Correct')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`incorrect_info_${tradeId}`)
      .setLabel('Incorrect')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function handleConfirmInfo(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
    return interaction.reply({ content: '❌ Not your trade.', flags: MessageFlags.Ephemeral });
  }

  const confirmKey = `info_${tradeId}_${interaction.user.id}`;
  if (confirmedInteractions.has(confirmKey)) {
    return interaction.reply({ content: '✅ Already confirmed!', flags: MessageFlags.Ephemeral });
  }
  confirmedInteractions.add(confirmKey);

  await interaction.reply({ content: `✅ ${interaction.user.toString()} clicked Correct.`, ephemeral: false });

  const otherUserId = interaction.user.id === trade.user1Id ? trade.user2Id : trade.user1Id;
  const otherKey = `info_${tradeId}_${otherUserId}`;
  
  if (confirmedInteractions.has(otherKey)) {
    await promptForAmount(interaction.channel, tradeId);
  }
}

// ==================== AMOUNT SETTING ====================

async function promptForAmount(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const embed = new EmbedBuilder()
    .setDescription('💵 **Set the amount in USD value**')
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`set_amount_${tradeId}`)
      .setLabel('Set USD Amount')
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ content: `<@${trade.senderId}>`, embeds: [embed], components: [row] });
}

async function handleSetAmount(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.senderId) {
    return interaction.reply({ content: '❌ Only the sender can set the amount.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`amount_modal_${tradeId}`)
    .setTitle('Set USD Amount');

  const amountInput = new TextInputBuilder()
    .setCustomId('usd_amount')
    .setLabel('USD Amount')
    .setPlaceholder('30')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
  await interaction.showModal(modal);
}

// ==================== MODAL HANDLER ====================

async function handleModal(interaction) {
  if (interaction.customId.startsWith('amount_modal_')) {
    await handleAmountModal(interaction);
    return;
  }

  if (interaction.customId.startsWith('address_modal_')) {
    await handleAddressModal(interaction);
    return;
  }
}

async function handleAmountModal(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const amountStr = interaction.fields.getTextInputValue('usd_amount');
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || amount <= 0) {
    return interaction.reply({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
  }

  const ltcPrice = await getLtcPriceUSD();
  const ltcAmount = amount / ltcPrice;
  const feePercent = await getFeePercent();
  const fee = calculateFee(amount, feePercent);
  const totalUsd = amount + fee;
  const totalLtc = totalUsd / ltcPrice;

  db.prepare(`
    UPDATE trades SET amount = ?, fee = ?, ltcPrice = ?, ltcAmount = ?, totalLtc = ?, status = 'amount_set'
    WHERE id = ?
  `).run(amount, fee, ltcPrice, ltcAmount, totalLtc, tradeId);

  const embed = new EmbedBuilder()
    .setDescription(`**USD amount set to $${amount.toFixed(2)}**\n\nPlease confirm the USD amount.`)
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_amount_${tradeId}`)
      .setLabel('Correct')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`incorrect_amount_${tradeId}`)
      .setLabel('Incorrect')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleAddressModal(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const address = interaction.fields.getTextInputValue('ltc_address').trim();

  if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M')) {
    return interaction.reply({ content: '❌ Invalid LTC address.', flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Confirm Address')
    .setDescription(`**Address:**\n\`${address}\`\n\nClick **"Confirm"** to send LTC or **"Back"** to cancel.`)
    .setColor(0xFFD700);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_withdraw_${tradeId}_${address}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`back_${tradeId}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ==================== AMOUNT CONFIRMATION ====================

async function handleConfirmAmount(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
    return interaction.reply({ content: '❌ Not your trade.', flags: MessageFlags.Ephemeral });
  }

  const confirmKey = `amount_${tradeId}_${interaction.user.id}`;
  if (confirmedInteractions.has(confirmKey)) {
    return interaction.reply({ content: '✅ Already confirmed!', flags: MessageFlags.Ephemeral });
  }
  confirmedInteractions.add(confirmKey);

  await interaction.reply({ content: `✅ ${interaction.user.toString()} confirmed the USD amount.`, ephemeral: false });

  const otherUserId = interaction.user.id === trade.user1Id ? trade.user2Id : trade.user1Id;
  const otherKey = `amount_${tradeId}_${otherUserId}`;

  if (confirmedInteractions.has(otherKey)) {
    await sendPaymentInstructions(interaction.channel, tradeId);
  }
}

// ==================== PAYMENT INSTRUCTIONS ====================

async function sendPaymentInstructions(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  
  const depositIndex = tradeId;
  const depositAddress = generateAddress(depositIndex);

  db.prepare("UPDATE trades SET depositAddress = ?, depositIndex = ?, status = 'awaiting_payment' WHERE id = ?")
    .run(depositAddress, depositIndex, tradeId);

  const embed = new EmbedBuilder()
    .setDescription(`<@${trade.senderId}> Send the LTC to the following address.`)
    .addFields(
      { name: '📋 Payment Information', value: 'Make sure to send the **EXACT** amount in LTC.' },
      { name: 'USD Amount', value: `$${trade.amount.toFixed(2)}` },
      { name: 'LTC Amount', value: trade.totalLtc.toFixed(5) },
      { name: 'Payment Address', value: `\`${depositAddress}\`` },
      { name: 'Current LTC Price', value: `$${trade.ltcPrice.toFixed(2)}` },
      { name: '⏰ Timeout', value: 'This ticket will be closed within 20 minutes if no transaction was detected.' }
    )
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_details_${tradeId}`)
      .setLabel('Copy Details')
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });

  startPaymentMonitor(tradeId, channel.id, trade.totalLtc);
}

// ==================== PAYMENT MONITORING ====================

function startPaymentMonitor(tradeId, channelId, expectedLtc) {
  if (activeMonitors.has(tradeId)) return;

  console.log(`[Monitor] Starting monitor for trade ${tradeId}, expecting ${expectedLtc} LTC`);

  let detected = false;
  const intervalId = setInterval(async () => {
    try {
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
      if (!trade || trade.status === 'completed' || trade.status === 'cancelled') {
        clearInterval(intervalId);
        activeMonitors.delete(tradeId);
        return;
      }

      const balance = await getAddressBalance(trade.depositAddress, true);
      
      if (!detected && balance.unconfirmed > 0) {
        detected = true;
        await handleTransactionDetected(tradeId, balance.unconfirmed, false);
      }

      if (balance.confirmed >= expectedLtc * 0.99) {
        clearInterval(intervalId);
        activeMonitors.delete(tradeId);
        await handleTransactionConfirmed(tradeId);
      }
    } catch (err) {
      console.error('[Monitor] Error:', err.message);
    }
  }, 15000);

  setTimeout(() => {
    if (activeMonitors.has(tradeId)) {
      clearInterval(intervalId);
      activeMonitors.delete(tradeId);
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
      if (trade && trade.status === 'awaiting_payment') {
        const channel = client.channels.cache.get(channelId);
        if (channel) channel.send('❌ Payment timeout - closing ticket');
      }
    }
  }, 20 * 60 * 1000);

  activeMonitors.set(tradeId, intervalId);
}

async function handleTransactionDetected(tradeId, amount, confirmed) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const channel = client.channels.cache.get(trade.channelId);
  if (!channel) return;

  const txHash = await checkTransactionMempool(trade.depositAddress) || 'pending';

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Transaction Detected')
    .setDescription('The transaction is currently **unconfirmed** and waiting for 1 confirmation.')
    .addFields(
      { name: 'Transaction', value: `[${txHash.substring(0, 10)}...${txHash.substring(txHash.length-8)}](https://live.blockcypher.com/ltc/tx/${txHash})` },
      { name: 'Amount Received', value: `${amount.toFixed(8)} LTC ($${(amount * trade.ltcPrice).toFixed(2)})` },
      { name: 'Required Amount', value: `${trade.totalLtc.toFixed(5)} LTC ($${(trade.totalLtc * trade.ltcPrice).toFixed(2)})` }
    )
    .setColor(0xFFD700);

  await channel.send({ embeds: [embed] });
}

async function handleTransactionConfirmed(tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const channel = client.channels.cache.get(trade.channelId);
  if (!channel) return;

  db.prepare("UPDATE trades SET status = 'awaiting_release' WHERE id = ?").run(tradeId);

  const txHash = await checkTransactionMempool(trade.depositAddress) || 'confirmed';

  const embed = new EmbedBuilder()
    .setTitle('✅ Transaction Confirmed!')
    .addFields(
      { name: 'Transaction', value: `[${txHash.substring(0, 10)}...${txHash.substring(txHash.length-8)}](https://live.blockcypher.com/ltc/tx/${txHash})` },
      { name: 'Total Amount Received', value: `${trade.totalLtc.toFixed(8)} LTC ($${(trade.totalLtc * trade.ltcPrice).toFixed(2)})` }
    )
    .setColor(0x00FF00);

  await channel.send({ embeds: [embed] });

  const proceedEmbed = new EmbedBuilder()
    .setTitle('✅ You may proceed with your trade.')
    .setDescription(`1. <@${trade.receiverId}> **Give your trader the items or payment you agreed on.**\n\n2. <@${trade.senderId}> **Once you have received your items, click "Release" so your trader can claim the LTC.**`)
    .setColor(0x00FF00);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`release_${tradeId}`)
      .setLabel('Release')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cancel_trade_${tradeId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({ content: `<@${trade.senderId}> <@${trade.receiverId}>`, embeds: [proceedEmbed], components: [row] });
}

// ==================== RELEASE & WITHDRAWAL ====================

async function handleRelease(interaction) {
  const tradeId = interaction.customId.split('_')[1];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.senderId) {
    return interaction.reply({ content: '❌ Only the sender can release funds!', flags: MessageFlags.Ephemeral });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle('⚠️ Are you sure you want to release the LTC?')
    .setDescription('Clicking **"Confirm"** will give your trader permission to withdraw the LTC.')
    .setColor(0xFFD700);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_release_${tradeId}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`back_release_${tradeId}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: false });
}

async function promptForAddress(interaction, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const embed = new EmbedBuilder()
    .setDescription('💰 **What\'s Your LTC Address?**\nMake sure to paste your correct LTC address.')
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`enter_address_${tradeId}`)
      .setLabel('Enter Your LTC Address')
      .setStyle(ButtonStyle.Primary)
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content: `<@${trade.receiverId}>`, embeds: [embed], components: [row] });
  } else {
    await interaction.update({ content: `<@${trade.receiverId}>`, embeds: [embed], components: [row] });
  }
}

async function handleConfirmWithdraw(interaction) {
  const parts = interaction.customId.split('_');
  const tradeId = parts[2];
  const address = parts[3];

  const trade = db.prepare('SELECT * FROM trades WHERE id = ?      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_receiver_${tradeId}`)
      .setLabel('Receiver')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_reset_${tradeId}`)
      .setLabel('Reset')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({ embeds: [roleEmbed], components: [roleRow] });

  await interaction.editReply({ content: `✅ Trade channel created: ${channel}` });
}

// ==================== BUTTON HANDLER ====================

async function handleButton(interaction) {
  const customId = interaction.customId;
  
  // Prevent double clicks
  const interactionKey = `${interaction.user.id}_${customId}`;
  if (confirmedInteractions.has(interactionKey)) {
    return interaction.reply({ content: '⏳ Processing...', flags: MessageFlags.Ephemeral });
  }

  // Delete ticket
  if (customId.startsWith('delete_ticket_')) {
    await interaction.channel.delete();
    return;
  }

  // Role selection
  if (customId.startsWith('role_')) {
    await handleRoleSelection(interaction);
    return;
  }

  // Confirm info
  if (customId.startsWith('confirm_info_')) {
    await handleConfirmInfo(interaction);
    return;
  }

  // Incorrect info
  if (customId.startsWith('incorrect_info_')) {
    await interaction.reply({ content: '❌ Please state the correct trade details in chat.', ephemeral: false });
    return;
  }

  // Set USD amount
  if (customId.startsWith('set_amount_')) {
    await handleSetAmount(interaction);
    return;
  }

  // Confirm USD amount
  if (customId.startsWith('confirm_amount_')) {
    await handleConfirmAmount(interaction);
    return;
  }

  // Incorrect amount
  if (customId.startsWith('incorrect_amount_')) {
    await interaction.reply({ content: '❌ Please set the correct amount.', ephemeral: false });
    return;
  }

  // Release funds
  if (customId.startsWith('release_')) {
    await handleRelease(interaction);
    return;
  }

  // Confirm release (from the warning message)
  if (customId.startsWith('confirm_release_')) {
    const tradeId = customId.split('_')[2];
    await promptForAddress(interaction, tradeId);
    return;
  }

  // Back release
  if (customId.startsWith('back_release_')) {
    await interaction.update({ content: '❌ Release cancelled.', components: [], embeds: [] });
    return;
  }

  // Cancel trade
  if (customId.startsWith('cancel_trade_')) {
    await interaction.update({ content: '❌ Cancelled.', components: [], embeds: [] });
    return;
  }

  // Enter address
  if (customId.startsWith('enter_address_')) {
    const tradeId = customId.split('_')[2];
    
    const modal = new ModalBuilder()
      .setCustomId(`address_modal_${tradeId}`)
      .setTitle('Enter Your LTC Address');

    const addressInput = new TextInputBuilder()
      .setCustomId('ltc_address')
      .setLabel('LTC Address')
      .setPlaceholder('LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(addressInput));
    await interaction.showModal(modal);
    return;
  }

  // Confirm withdrawal address
  if (customId.startsWith('confirm_withdraw_')) {
    await handleConfirmWithdraw(interaction);
    return;
  }

  // Back button
  if (customId.startsWith('back_')) {
    const tradeId = customId.split('_')[1];
    await promptForAddress(interaction, tradeId);
    return;
  }

  // Close ticket
  if (customId === 'close_ticket') {
    await interaction.channel.delete();
    return;
  }

  // Copy details
  if (customId.startsWith('copy_details_')) {
    await interaction.reply({ content: '✅ Details copied to clipboard!', flags: MessageFlags.Ephemeral });
    return;
  }

  // Confirm sendall
  if (customId.startsWith('confirm_sendall_')) {
    const parts = interaction.customId.split('_');
    const address = parts[3];
    
    await interaction.update({ content: '⏳ Processing...', components: [], embeds: [] });

    const result = await sendAllLTC(address);
    
    if (result.success) {
      const embed = new EmbedBuilder()
        .setTitle('✅ Sent')
        .addFields(
          { name: 'Amount', value: result.amountSent || '?' },
          { name: 'To', value: address },
          { name: 'TxID', value: result.txid }
        )
        .setColor('Green');
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.editReply({ content: `❌ Failed: ${result.error}` });
    }
    return;
  }

  // Cancel sendall
  if (customId === 'cancel_sendall') {
    await interaction.update({ content: '❌ Cancelled.', components: [], embeds: [] });
    return;
  }
}

// ==================== ROLE SELECTION ====================

async function handleRoleSelection(interaction) {
  const parts = interaction.customId.split('_');
  const action = parts[1];
  const tradeId = parts[2];

  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (action === 'reset') {
    db.prepare('UPDATE trades SET senderId = NULL, receiverId = NULL WHERE id = ?').run(tradeId);
    await updateRoleDisplay(interaction, tradeId);
    return interaction.reply({ content: '✅ Roles reset.', flags: MessageFlags.Ephemeral });
  }

  const isSender = action === 'sender';
  const userId = interaction.user.id;

  if (userId !== trade.user1Id && userId !== trade.user2Id) {
    return interaction.reply({ content: '❌ You are not part of this trade.', flags: MessageFlags.Ephemeral });
  }

  if (isSender && trade.senderId === userId) {
    return interaction.reply({ content: '✅ You are already the Sender!', flags: MessageFlags.Ephemeral });
  }
  if (!isSender && trade.receiverId === userId) {
    return interaction.reply({ content: '✅ You are already the Receiver!', flags: MessageFlags.Ephemeral });
  }

  if (isSender && trade.receiverId === userId) {
    return interaction.reply({ content: '❌ You cannot be both Sender and Receiver!', flags: MessageFlags.Ephemeral });
  }
  if (!isSender && trade.senderId === userId) {
    return interaction.reply({ content: '❌ You cannot be both Sender and Receiver!', flags: MessageFlags.Ephemeral });
  }

  if (isSender) {
    db.prepare('UPDATE trades SET senderId = ? WHERE id = ?').run(userId, tradeId);
  } else {
    db.prepare('UPDATE trades SET receiverId = ? WHERE id = ?').run(userId, tradeId);
  }

  await interaction.reply({ content: `✅ You are now the ${isSender ? 'Sender' : 'Receiver'}!`, flags: MessageFlags.Ephemeral });

  await updateRoleDisplay(interaction, tradeId);

  const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (updated.senderId && updated.receiverId) {
    await sendInfoConfirmation(interaction.channel, tradeId);
  }
}

async function updateRoleDisplay(interaction, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  
  let description = '**Select your role**\n• **"Sender"** if you are **Sending** LTC to the bot.\n• **"Receiver"** if you are **Receiving** LTC *later* from the bot.\n\n';

  if (trade.senderId) {
    const sender = await client.users.fetch(trade.senderId).catch(() => null);
    description += `**Sender:** ${sender ? sender.toString() : 'Unknown'}\n`;
  }
  if (trade.receiverId) {
    const receiver = await client.users.fetch(trade.receiverId).catch(() => null);
    description += `**Receiver:** ${receiver ? receiver.toString() : 'Unknown'}\n`;
  }

  const embed = new EmbedBuilder().setDescription(description).setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`role_sender_${tradeId}`)
      .setLabel('Sender')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_receiver_${tradeId}`)
      .setLabel('Receiver')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`role_reset_${tradeId}`)
      .setLabel('Reset')
      .setStyle(ButtonStyle.Danger)
  );

  const messages = await interaction.channel.messages.fetch({ limit: 10 });
  const roleMsg = messages.find(m => m.embeds[0]?.description?.includes('Select your role'));
  if (roleMsg) {
    await roleMsg.edit({ embeds: [embed], components: [row] });
  }
}

// ==================== INFO CONFIRMATION ====================

async function sendInfoConfirmation(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const sender = await client.users.fetch(trade.senderId).catch(() => null);
  const receiver = await client.users.fetch(trade.receiverId).catch(() => null);

  const embed = new EmbedBuilder()
    .setTitle('• Is This Information Correct?')
    .addFields(
      { name: 'Sender', value: sender ? sender.toString() : 'Unknown', inline: false },
      { name: 'Receiver', value: receiver ? receiver.toString() : 'Unknown', inline: false }
    )
    .setDescription('Make sure you have selected the right role! If you didn\'t then click "Incorrect"')
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_info_${tradeId}`)
      .setLabel('Correct')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`incorrect_info_${tradeId}`)
      .setLabel('Incorrect')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function handleConfirmInfo(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
    return interaction.reply({ content: '❌ Not your trade.', flags: MessageFlags.Ephemeral });
  }

  const confirmKey = `info_${tradeId}_${interaction.user.id}`;
  if (confirmedInteractions.has(confirmKey)) {
    return interaction.reply({ content: '✅ Already confirmed!', flags: MessageFlags.Ephemeral });
  }
  confirmedInteractions.add(confirmKey);

  await interaction.reply({ content: `✅ ${interaction.user.toString()} clicked Correct.`, ephemeral: false });

  const otherUserId = interaction.user.id === trade.user1Id ? trade.user2Id : trade.user1Id;
  const otherKey = `info_${tradeId}_${otherUserId}`;
  
  if (confirmedInteractions.has(otherKey)) {
    await promptForAmount(interaction.channel, tradeId);
  }
}

// ==================== AMOUNT SETTING ====================

async function promptForAmount(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const embed = new EmbedBuilder()
    .setDescription('💵 **Set the amount in USD value**')
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`set_amount_${tradeId}`)
      .setLabel('Set USD Amount')
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ content: `<@${trade.senderId}>`, embeds: [embed], components: [row] });
}

async function handleSetAmount(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.senderId) {
    return interaction.reply({ content: '❌ Only the sender can set the amount.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`amount_modal_${tradeId}`)
    .setTitle('Set USD Amount');

  const amountInput = new TextInputBuilder()
    .setCustomId('usd_amount')
    .setLabel('USD Amount')
    .setPlaceholder('30')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
  await interaction.showModal(modal);
}

// ==================== MODAL HANDLER ====================

async function handleModal(interaction) {
  if (interaction.customId.startsWith('amount_modal_')) {
    await handleAmountModal(interaction);
    return;
  }

  if (interaction.customId.startsWith('address_modal_')) {
    await handleAddressModal(interaction);
    return;
  }
}

async function handleAmountModal(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const amountStr = interaction.fields.getTextInputValue('usd_amount');
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || amount <= 0) {
    return interaction.reply({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
  }

  const ltcPrice = await getLtcPriceUSD();
  const ltcAmount = amount / ltcPrice;
  const feePercent = await getFeePercent();
  const fee = calculateFee(amount, feePercent);
  const totalUsd = amount + fee;
  const totalLtc = totalUsd / ltcPrice;

  db.prepare(`
    UPDATE trades SET amount = ?, fee = ?, ltcPrice = ?, ltcAmount = ?, totalLtc = ?, status = 'amount_set'
    WHERE id = ?
  `).run(amount, fee, ltcPrice, ltcAmount, totalLtc, tradeId);

  const embed = new EmbedBuilder()
    .setDescription(`**USD amount set to $${amount.toFixed(2)}**\n\nPlease confirm the USD amount.`)
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_amount_${tradeId}`)
      .setLabel('Correct')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`incorrect_amount_${tradeId}`)
      .setLabel('Incorrect')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleAddressModal(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const address = interaction.fields.getTextInputValue('ltc_address').trim();

  if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M')) {
    return interaction.reply({ content: '❌ Invalid LTC address.', flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Confirm Address')
    .setDescription(`**Address:**\n\`${address}\`\n\nClick **"Confirm"** to send LTC or **"Back"** to cancel.`)
    .setColor(0xFFD700);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_withdraw_${tradeId}_${address}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`back_${tradeId}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ==================== AMOUNT CONFIRMATION ====================

async function handleConfirmAmount(interaction) {
  const tradeId = interaction.customId.split('_')[2];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
    return interaction.reply({ content: '❌ Not your trade.', flags: MessageFlags.Ephemeral });
  }

  const confirmKey = `amount_${tradeId}_${interaction.user.id}`;
  if (confirmedInteractions.has(confirmKey)) {
    return interaction.reply({ content: '✅ Already confirmed!', flags: MessageFlags.Ephemeral });
  }
  confirmedInteractions.add(confirmKey);

  await interaction.reply({ content: `✅ ${interaction.user.toString()} confirmed the USD amount.`, ephemeral: false });

  const otherUserId = interaction.user.id === trade.user1Id ? trade.user2Id : trade.user1Id;
  const otherKey = `amount_${tradeId}_${otherUserId}`;

  if (confirmedInteractions.has(otherKey)) {
    await sendPaymentInstructions(interaction.channel, tradeId);
  }
}

// ==================== PAYMENT INSTRUCTIONS ====================

async function sendPaymentInstructions(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  
  const depositIndex = tradeId;
  const depositAddress = generateAddress(depositIndex);

  db.prepare("UPDATE trades SET depositAddress = ?, depositIndex = ?, status = 'awaiting_payment' WHERE id = ?")
    .run(depositAddress, depositIndex, tradeId);

  const embed = new EmbedBuilder()
    .setDescription(`<@${trade.senderId}> Send the LTC to the following address.`)
    .addFields(
      { name: '📋 Payment Information', value: 'Make sure to send the **EXACT** amount in LTC.' },
      { name: 'USD Amount', value: `$${trade.amount.toFixed(2)}` },
      { name: 'LTC Amount', value: trade.totalLtc.toFixed(5) },
      { name: 'Payment Address', value: `\`${depositAddress}\`` },
      { name: 'Current LTC Price', value: `$${trade.ltcPrice.toFixed(2)}` },
      { name: '⏰ Timeout', value: 'This ticket will be closed within 20 minutes if no transaction was detected.' }
    )
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_details_${tradeId}`)
      .setLabel('Copy Details')
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });

  startPaymentMonitor(tradeId, channel.id, trade.totalLtc);
}

// ==================== PAYMENT MONITORING ====================

function startPaymentMonitor(tradeId, channelId, expectedLtc) {
  if (activeMonitors.has(tradeId)) return;

  console.log(`[Monitor] Starting monitor for trade ${tradeId}, expecting ${expectedLtc} LTC`);

  let detected = false;
  const intervalId = setInterval(async () => {
    try {
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
      if (!trade || trade.status === 'completed' || trade.status === 'cancelled') {
        clearInterval(intervalId);
        activeMonitors.delete(tradeId);
        return;
      }

      const balance = await getAddressBalance(trade.depositAddress, true);
      
      if (!detected && balance.unconfirmed > 0) {
        detected = true;
        await handleTransactionDetected(tradeId, balance.unconfirmed, false);
      }

      if (balance.confirmed >= expectedLtc * 0.99) {
        clearInterval(intervalId);
        activeMonitors.delete(tradeId);
        await handleTransactionConfirmed(tradeId);
      }
    } catch (err) {
      console.error('[Monitor] Error:', err.message);
    }
  }, 15000);

  setTimeout(() => {
    if (activeMonitors.has(tradeId)) {
      clearInterval(intervalId);
      activeMonitors.delete(tradeId);
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
      if (trade && trade.status === 'awaiting_payment') {
        const channel = client.channels.cache.get(channelId);
        if (channel) channel.send('❌ Payment timeout - closing ticket');
      }
    }
  }, 20 * 60 * 1000);

  activeMonitors.set(tradeId, intervalId);
}

async function handleTransactionDetected(tradeId, amount, confirmed) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const channel = client.channels.cache.get(trade.channelId);
  if (!channel) return;

  const txHash = await checkTransactionMempool(trade.depositAddress) || 'pending';

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Transaction Detected')
    .setDescription('The transaction is currently **unconfirmed** and waiting for 1 confirmation.')
    .addFields(
      { name: 'Transaction', value: `[${txHash.substring(0, 10)}...${txHash.substring(txHash.length-8)}](https://live.blockcypher.com/ltc/tx/${txHash})` },
      { name: 'Amount Received', value: `${amount.toFixed(8)} LTC ($${(amount * trade.ltcPrice).toFixed(2)})` },
      { name: 'Required Amount', value: `${trade.totalLtc.toFixed(5)} LTC ($${(trade.totalLtc * trade.ltcPrice).toFixed(2)})` }
    )
    .setColor(0xFFD700);

  await channel.send({ embeds: [embed] });
}

async function handleTransactionConfirmed(tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const channel = client.channels.cache.get(trade.channelId);
  if (!channel) return;

  db.prepare("UPDATE trades SET status = 'awaiting_release' WHERE id = ?").run(tradeId);

  const txHash = await checkTransactionMempool(trade.depositAddress) || 'confirmed';

  const embed = new EmbedBuilder()
    .setTitle('✅ Transaction Confirmed!')
    .addFields(
      { name: 'Transaction', value: `[${txHash.substring(0, 10)}...${txHash.substring(txHash.length-8)}](https://live.blockcypher.com/ltc/tx/${txHash})` },
      { name: 'Total Amount Received', value: `${trade.totalLtc.toFixed(8)} LTC ($${(trade.totalLtc * trade.ltcPrice).toFixed(2)})` }
    )
    .setColor(0x00FF00);

  await channel.send({ embeds: [embed] });

  const proceedEmbed = new EmbedBuilder()
    .setTitle('✅ You may proceed with your trade.')
    .setDescription(`1. <@${trade.receiverId}> **Give your trader the items or payment you agreed on.**\n\n2. <@${trade.senderId}> **Once you have received your items, click "Release" so your trader can claim the LTC.**`)
    .setColor(0x00FF00);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`release_${tradeId}`)
      .setLabel('Release')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cancel_trade_${tradeId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({ content: `<@${trade.senderId}> <@${trade.receiverId}>`, embeds: [proceedEmbed], components: [row] });
}

// ==================== RELEASE & WITHDRAWAL ====================

async function handleRelease(interaction) {
  const tradeId = interaction.customId.split('_')[1];
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  if (!trade) return interaction.reply({ content: 'Trade not found.', flags: MessageFlags.Ephemeral });

  if (interaction.user.id !== trade.senderId) {
    return interaction.reply({ content: '❌ Only the sender can release funds!', flags: MessageFlags.Ephemeral });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle('⚠️ Are you sure you want to release the LTC?')
    .setDescription('Clicking **"Confirm"** will give your trader permission to withdraw the LTC.')
    .setColor(0xFFD700);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_release_${tradeId}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`back_release_${tradeId}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: false });
}

async function promptForAddress(interaction, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const embed = new EmbedBuilder()
    .setDescription('💰 **What\'s Your LTC Address?**\nMake sure to paste your correct LTC address.')
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`enter_address_${tradeId}`)
      .setLabel('Enter Your LTC Address')
      .setStyle(ButtonStyle.Primary)
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content: `<@${trade.receiverId}>`, embeds: [embed], components: [row] });
  } else {
    await interaction.update({ content: `<@${trade.receiverId}>`, embeds: [embed], components: [row] });
  }
}

async function handleConfirmWithdraw(interaction) {
  const parts = interaction.customId.split('_');
  const tradeId = parts[2];
  const address = parts[3];

  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const sendingEmbed = new EmbedBuilder()
    .setDescription('⏳ **Sending...**')
    .setColor(0x5865F2);

  await interaction.update({ embeds: [sendingEmbed], components: [] });

  try {
    const feeLtc = (trade.fee / trade.ltcPrice).toFixed(8);
    const amountLtc = trade.ltcAmount;

    const result = await sendLTC(tradeId, address, amountLtc);

    if (result.success) {
      await sendFeeToAddress(FEE_ADDRESS, feeLtc, tradeId);

      db.prepare("UPDATE trades SET status = 'completed', completedAt = datetime('now'), receiverAddress = ? WHERE id = ?")
        .run(address, tradeId);

      const successEmbed = new EmbedBuilder()
        .setTitle('✅ Withdrawal Successful')
        .setDescription('Use `/setprivacy` to display your user in #🍦・completed')
        .addFields(
          { name: 'Transaction', value: `[${result.txid.substring(0, 10)}...${result.txid.substring(result.txid.length-8)}](https://live.blockcypher.com/ltc/tx/${result.txid})` },
          { name: 'Amount Sent', value: `${amountLtc.toFixed(8)} LTC ($${(amountLtc * trade.ltcPrice).toFixed(2)})` }
        )
        .setColor(0x00FF00);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('close_ticket')
          .setLabel('🔒 Close Ticket')
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.editReply({ embeds: [successEmbed], components: [row] });

      setTimeout(() => {
        interaction.channel.delete().catch(() => {});
      }, 120000);
    } else {
      await interaction.editReply({ content: `❌ Withdrawal failed: ${result.error}`, components: [] });
    }
  } catch (err) {
    console.error('Withdrawal error:', err);
    await interaction.editReply({ content: '❌ Withdrawal failed. Check console.', components: [] });
  }
}

// ==================== OTHER COMMANDS ====================

async function showBalance(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!await hasOwnerPermissions(interaction.user.id, interaction.member)) {
    return interaction.editReply({ content: '❌ Only owner can use this.' });
  }

  const balance = await getBalanceAtIndex(0, true);
  const address = generateAddress(0);

  if (balance <= 0) {
    return interaction.editReply({ content: `❌ No LTC found.\nAddress: \`${address}\`` });
  }

  const ltcPrice = await getLtcPriceUSD();
  const usdValue = (balance * ltcPrice).toFixed(2);

  const embed = new EmbedBuilder()
    .setTitle('💰 Wallet Balance')
    .setDescription(`**Balance:** ${balance.toFixed(8)} LTC (~$${usdValue})`)
    .addFields({ name: 'Address', value: `\`${address}\``, inline: false })
    .setColor('Green');

  await interaction.editReply({ embeds: [embed] });
}

async function handleSendCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!await hasOwnerPermissions(interaction.user.id, interaction.member)) {
    return interaction.editReply({ content: '❌ Only owner can use this.' });
  }

  const address = interaction.options.getString('address').trim();
  if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M')) {
    return interaction.editReply({ content: '❌ Invalid address.' });
  }

  const balance = await getBalanceAtIndex(0, true);
  if (balance <= 0) {
    return interaction.editReply({ content: `❌ No funds. Address: \`${generateAddress(0)}\`` });
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Confirm Send')
    .setDescription(`Send **${balance.toFixed(8)} LTC** to \`${address}\`?`)
    .setColor('Orange');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_sendall_0_${address}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cancel_sendall`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function setFeeCommand(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Only owner.', flags: MessageFlags.Ephemeral });
  }

  const percent = interaction.options.getNumber('percentage');
  if (percent < 0 || percent > 50) {
    return interaction.reply({ content: '❌ Fee must be 0-50%.', flags: MessageFlags.Ephemeral });
  }

  db.prepare("INSERT OR REPLACE INTO config(key,value) VALUES('feePercent',?)").run(percent.toString());
  return interaction.reply({ content: `✅ Fee set to ${percent}%.`, flags: MessageFlags.Ephemeral });
}

async function closeTicket(interaction) {
  const trade = db.prepare('SELECT * FROM trades WHERE channelId = ?').get(interaction.channel.id);
  if (!trade) {
    return interaction.reply({ content: '❌ No active trade here.', flags: MessageFlags.Ephemeral });
  }

  if (trade.status === 'completed' || trade.status === 'cancelled') {
    await interaction.channel.delete();
  } else {
    return interaction.reply({ content: '❌ Cannot close active trade.', flags: MessageFlags.Ephemeral });
  }
}

// ==================== HELPER FUNCTIONS ====================

async function getAddressBalance(address, forceRefresh = false) {
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${process.env.BLOCKCYPHER_TOKEN}`;
    const res = await axios.get(url, { timeout: 10000 });
    
    return {
      confirmed: (res.data.balance || 0) / 1e8,
      unconfirmed: (res.data.unconfirmed_balance || 0) / 1e8,
      total: (res.data.balance + res.data.unconfirmed_balance) / 1e8
    };
  } catch (err) {
    console.error('Balance check error:', err.message);
    return { confirmed: 0, unconfirmed: 0, total: 0 };
  }
}

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  activeMonitors.forEach((id) => clearInterval(id));
  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login:', err);
  process.exit(1);
});
