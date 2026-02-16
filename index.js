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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const db = require('./database');
const { initWallet, generateAddress, sendLTC, getWalletBalance, sendAllLTC, isInitialized, getBalanceAtIndex, sendFeeToAddress } = require('./wallet');
const { checkPayment, getLtcPriceUSD, checkTransactionMempool } = require('./blockchain');
const { REST } = require('@discordjs/rest');
const QRCode = require('qrcode');
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

if (!DISCORD_TOKEN || !OWNER_ID || !process.env.BOT_MNEMONIC) {
  console.error('Missing required environment variables. Check your .env file.');
  process.exit(1);
}

const walletInitialized = initWallet(process.env.BOT_MNEMONIC);
if (!walletInitialized) {
  console.error('Failed to initialize wallet. Check your BOT_MNEMONIC in .env');
  process.exit(1);
}

const activeMonitors = new Map();
const pendingRefunds = new Map();
const pendingReleases = new Map();

async function hasOwnerPermissions(userId, member) {
  if (userId === OWNER_ID) return true;
  if (OWNER_ROLE_ID && member) {
    return member.roles.cache.has(OWNER_ROLE_ID);
  }
  return false;
}

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Show the trading panel'),
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check wallet balance (Owner only)')
    .addBooleanOption((opt) =>
      opt.setName('refresh').setDescription('Force refresh from blockchain').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Debug API connection (Owner only)')
    .addStringOption((opt) =>
      opt.setName('address').setDescription('Address to check').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('logchannel')
    .setDescription('Set a log channel (Admin only)')
    .addStringOption((opt) =>
      opt.setName('channelid').setDescription('Channel ID').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('setfee')
    .setDescription('Set fee percentage (Admin only)')
    .addNumberOption((opt) =>
      opt.setName('percentage').setDescription('Fee % (e.g., 5 for 5%)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Manually check payment status (Admin only)')
    .addStringOption((opt) =>
      opt.setName('tradeid').setDescription('Trade ID').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send all LTC to an address (Owner only)')
    .addStringOption((opt) =>
      opt.setName('address').setDescription('Litecoin address to send to').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('index').setDescription('Address index (default: auto-detect)').setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

function calculateFee(amount, feePercent = 5) {
  return (amount * feePercent) / 100;
}

async function log(guild, msg) {
  try {
    const row = db.prepare(`SELECT value FROM config WHERE key='logChannel'`).get();
    if (!row) return;
    const ch = await guild.channels.fetch(row.value).catch(() => null);
    if (ch) {
      const embed = new EmbedBuilder()
        .setDescription(msg)
        .setTimestamp()
        .setColor('Grey');
      ch.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Logging error:', err);
  }
}

async function getFeePercent() {
  const row = db.prepare(`SELECT value FROM config WHERE key='feePercent'`).get();
  return row ? parseFloat(row.value) : 5;
}

function startPaymentMonitor(tradeId, channelId, expectedUsd) {
  if (activeMonitors.has(tradeId)) return;

  console.log(`[Monitor] Starting payment monitor for trade ${tradeId}, expecting $${expectedUsd}`);
  let mempoolDetected = false;

  const intervalId = setInterval(async () => {
    try {
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
      if (!trade || trade.status === 'completed' || trade.status === 'cancelled' || trade.status === 'refunded') {
        stopPaymentMonitor(tradeId);
        return;
      }

      const mempoolTx = await checkTransactionMempool(trade.depositAddress);
      
      if (mempoolTx && !mempoolDetected && trade.status === 'awaiting_payment') {
        mempoolDetected = true;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send('⏳ **Transaction detected in mempool!** Waiting for blockchain confirmation... TxID: `' + mempoolTx + '`');
        }
      }

      const paid = await checkPayment(trade.depositAddress, expectedUsd);

      if (paid && trade.status === 'awaiting_payment') {
        db.prepare(`UPDATE trades SET status = 'paid', paidAt = datetime('now'), txid = ? WHERE id = ?`).run(mempoolTx || 'confirmed', tradeId);

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          const sender = await client.users.fetch(trade.senderId).catch(() => null);
          const receiver = await client.users.fetch(trade.receiverId).catch(() => null);

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`release_${tradeId}`)
              .setLabel('Release')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`refund_${tradeId}`)
              .setLabel('Refund')
              .setStyle(ButtonStyle.Danger)
          );

          await channel.send({
            content: '✅ **Payment confirmed!** Sender: ' + (sender ? sender.tag : 'Unknown') + ' | Receiver: ' + (receiver ? receiver.tag : 'Unknown') + '. Click **Release** to send funds to receiver, or **Refund** to return to sender.',
            components: [row]
          });

          await log(channel.guild, `✅ Trade #${tradeId} payment confirmed, awaiting release`);
        }
      }
    } catch (err) {
      console.error(`[Monitor] Error checking payment for trade ${tradeId}:`, err);
    }
  }, 15000);

  activeMonitors.set(tradeId, intervalId);
}

function stopPaymentMonitor(tradeId) {
  const intervalId = activeMonitors.get(tradeId);
  if (intervalId) {
    clearInterval(intervalId);
    activeMonitors.delete(tradeId);
    console.log(`[Monitor] Stopped monitor for trade ${tradeId}`);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    console.log('🔄 Refreshing slash commands...');
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  const activeTrades = db.prepare(`SELECT * FROM trades WHERE status IN ('awaiting_payment', 'paid')`).all();
  for (const trade of activeTrades) {
    if (trade.amount && trade.amount > 0) {
      const totalUsd = trade.amount + trade.fee;
      startPaymentMonitor(trade.id, trade.channelId, totalUsd);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('$')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  const hasPermission = await hasOwnerPermissions(message.author.id, message.member);
  if (!hasPermission) {
    return message.reply('❌ Only owners can use this command.');
  }

  if (command === 'refund') {
    const tradeId = args[0];
    if (!tradeId) return message.reply('Usage: `$refund [trade-id]`');

    const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
    if (!trade) return message.reply('❌ Trade not found.');
    if (trade.status === 'refunded') return message.reply('❌ Already refunded.');

    await message.reply(`⏳ Processing force refund for trade #${tradeId}...`);

    try {
      const totalLtc = ((trade.amount + trade.fee) / trade.ltcPrice).toFixed(8);
      const refundAddress = trade.refundAddress || trade.senderAddress;
      if (!refundAddress) {
        return message.reply('❌ No sender address on file.');
      }

      const result = await sendLTC(tradeId, refundAddress, totalLtc);

      if (result.success) {
        db.prepare(`UPDATE trades SET status = 'refunded', refundedAt = datetime('now'), refundAddress = ? WHERE id = ?`).run(refundAddress, tradeId);
        stopPaymentMonitor(tradeId);

        await message.reply('↩️ **Force Refund Complete!** Amount: ' + totalLtc + ' LTC | To: `' + refundAddress + '` | TxID: `' + result.txid + '`');

        const channel = await client.channels.fetch(trade.channelId).catch(() => null);
        if (channel) {
          await channel.send(`↩️ **Trade #${tradeId} force refunded by owner.**`);
        }
        await log(message.guild, `↩️ Force refund Trade #${tradeId} by ${message.author.tag}`);
      } else {
        await message.reply(`❌ Refund failed: ${result.error}`);
      }
    } catch (err) {
      console.error('Force refund error:', err);
      await message.reply('❌ Refund failed. Check console.');
    }
    return;
  }

  if (command === 'release') {
    const tradeId = args[0];
    const receiverAddress = args[1];
    
    if (!tradeId || !receiverAddress) return message.reply('Usage: `$release [trade-id] [receiver-address]`');

    const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
    if (!trade) return message.reply('❌ Trade not found.');
    if (trade.status === 'completed') return message.reply('❌ Already completed.');

    await message.reply(`⏳ Processing force release for trade #${tradeId}...`);

    try {
      const feeLtc = (trade.fee / trade.ltcPrice).toFixed(8);
      const amountLtc = trade.ltcAmount;

      const result = await sendLTC(tradeId, receiverAddress, amountLtc);

      if (result.success) {
        await sendFeeToAddress(FEE_ADDRESS, feeLtc, tradeId);

        db.prepare(`UPDATE trades SET status = 'completed', completedAt = datetime('now'), receiverAddress = ? WHERE id = ?`).run(receiverAddress, tradeId);
        stopPaymentMonitor(tradeId);

        await message.reply('✅ **Force Release Complete!** Amount: ' + amountLtc + ' LTC | Fee: ' + feeLtc + ' LTC | To: `' + receiverAddress + '` | TxID: `' + result.txid + '`');

        const channel = await client.channels.fetch(trade.channelId).catch(() => null);
        if (channel) {
          await channel.send(`✅ **Trade #${tradeId} force released by owner.**`);
          setTimeout(() => channel.delete().catch(() => {}), 60000);
        }
        await log(message.guild, `✅ Force release Trade #${tradeId} by ${message.author.tag}`);
      } else {
        await message.reply(`❌ Release failed: ${result.error}`);
      }
    } catch (err) {
      console.error('Force release error:', err);
      await message.reply('❌ Release failed. Check console.');
    }
    return;
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'debug') {
        await interaction.deferReply({ ephemeral: true });

        const hasPermission = await hasOwnerPermissions(interaction.user.id, interaction.member);
        if (!hasPermission) {
          return interaction.editReply({ content: '❌ Only owner can use this.' });
        }

        const testAddress = interaction.options.getString('address') || 'ltc1qv2glqufvh326tpyty35ystvastavxcw0k4dhld';
        
        await interaction.editReply({ content: `Testing API for \`${testAddress}\`...` });

        try {
          const axios = require('axios');
          const res = await axios.get(`https://api.blockchair.com/litecoin/dashboards/address/${testAddress}`, { timeout: 15000 });
          
          const responseText = JSON.stringify(res.data, null, 2).substring(0, 1900);
          
          await interaction.followUp({
            content: `**API Response:**\n\`\`\`json\n${responseText}\n\`\`\``,
            ephemeral: true
          });
        } catch (err) {
          await interaction.followUp({
            content: `**Error:** ${err.message}`,
            ephemeral: true
          });
        }
        return;
      }

      if (commandName === 'balance') {
        await interaction.deferReply({ ephemeral: true });

        const hasPermission = await hasOwnerPermissions(interaction.user.id, interaction.member);
        if (!hasPermission) {
          return interaction.editReply({ content: '❌ Only owner can use this.' });
        }

        const forceRefresh = interaction.options.getBoolean('refresh') || false;

        await interaction.editReply({ content: `⏳ Scanning wallet indices... ${forceRefresh ? '(Force refresh)' : ''}` });

        try {
          const { total, found } = await getWalletBalance(forceRefresh);
          
          if (found.length === 0) {
            return interaction.editReply({ content: '❌ No LTC found in any wallet indices (0-20). Try: /balance refresh:true or check your BOT_MNEMONIC in .env' });
          }

          const ltcPrice = await getLtcPriceUSD();
          const usdValue = (total * ltcPrice).toFixed(2);

          let description = `**Total Balance:** ${total.toFixed(8)} LTC (~$${usdValue})\n\n**Found Funds:**\n`;
          found.forEach(({ index, balance }) => {
            const address = generateAddress(index);
            const usd = (balance * ltcPrice).toFixed(2);
            description += `\n[Index ${index}] ${balance.toFixed(8)} LTC (~$${usd})\n\`${address}\``;
          });

          const embed = new EmbedBuilder()
            .setTitle('💰 Wallet Balance')
            .setDescription(description)
            .setColor('Green')
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

        } catch (err) {
          console.error('Balance check error:', err);
          await interaction.editReply({ content: `❌ Error checking balance: ${err.message}` });
        }
        return;
      }

      if (commandName === 'send') {
        await interaction.deferReply({ ephemeral: true });

        if (!isInitialized()) {
          return interaction.editReply({ content: '❌ Wallet not initialized.' });
        }

        const hasPermission = await hasOwnerPermissions(interaction.user.id, interaction.member);
        if (!hasPermission) {
          return interaction.editReply({ content: '❌ Only owner can use this.' });
        }

        const address = interaction.options.getString('address').trim();
        let specificIndex = interaction.options.getInteger('index');

        if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M')) {
          return interaction.editReply({ content: '❌ Invalid Litecoin address.' });
        }

        console.log(`[Send] Checking for funds... ${specificIndex !== null ? `Index ${specificIndex}` : 'Auto-detect'}`);
        await interaction.editReply({ content: `⏳ Checking wallet... This may take a few seconds.` });

        let indexToUse = specificIndex;
        
        if (indexToUse === null) {
          console.log(`[Send] Auto-detecting funded index...`);
          for (let i = 0; i <= 20; i++) {
            const balance = await getBalanceAtIndex(i, true);
            if (balance > 0) {
              indexToUse = i;
              console.log(`[Send] Found funds at index ${i}: ${balance} LTC`);
              break;
            }
          }
        }

        if (indexToUse === null) {
          return interaction.editReply({ content: '❌ No funded addresses found (checked indices 0-20). Use /balance to see all indices, or specify an index: /send address:YOUR_ADDRESS index:1' });
        }

        const balance = await getBalanceAtIndex(indexToUse, true);
        console.log(`[Send] Index ${indexToUse} balance: ${balance} LTC`);

        if (!balance || balance <= 0) {
          return interaction.editReply({ content: `❌ No funds at index ${indexToUse}. Use /balance to check all indices.` });
        }

        const ltcPrice = await getLtcPriceUSD();
        const usdValue = (balance * ltcPrice).toFixed(2);

        const embed = new EmbedBuilder()
          .setTitle('⚠️ Confirm LTC Transfer')
          .setDescription(`Send **ALL** LTC from index ${indexToUse}?`)
          .setColor('Orange')
          .addFields(
            { name: 'Amount', value: `${balance.toFixed(8)} LTC (~$${usdValue})`, inline: true },
            { name: 'From Index', value: `${indexToUse}`, inline: true },
            { name: 'To Address', value: `\`${address}\``, inline: false }
          );

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_sendall_${indexToUse}_${address}`)
            .setLabel('Confirm Send')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`cancel_sendall`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );

        return interaction.editReply({ embeds: [embed], components: [confirmRow] });
      }

      if (commandName === 'logchannel') {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Only owner can use this.', ephemeral: true });
        }

        const id = interaction.options.getString('channelid');
        const channel = await interaction.guild.channels.fetch(id).catch(() => null);

        if (!channel) {
          return interaction.reply({ content: '❌ Invalid channel ID.', ephemeral: true });
        }

        db.prepare(`INSERT OR REPLACE INTO config(key,value) VALUES('logChannel',?)`).run(id);
        return interaction.reply({ content: `✅ Log channel set to ${channel}.`, ephemeral: true });
      }

      if (commandName === 'setfee') {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Only owner can use this.', ephemeral: true });
        }

        const percent = interaction.options.getNumber('percentage');
        if (percent < 0 || percent > 50) {
          return interaction.reply({ content: '❌ Fee must be between 0% and 50%.', ephemeral: true });
        }

        db.prepare(`INSERT OR REPLACE INTO config(key,value) VALUES('feePercent',?)`).run(percent.toString());
        return interaction.reply({ content: `✅ Fee set to ${percent}%.`, ephemeral: true });
      }

      if (commandName === 'check') {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Only owner can use this.', ephemeral: true });
        }

        const tradeId = interaction.options.getString('tradeid');
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) {
          return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
        }

        await interaction.reply({ content: `🔍 Checking trade #${tradeId}...`, ephemeral: true });

        const totalUsd = trade.amount + trade.fee;
        const paid = await checkPayment(trade.depositAddress, totalUsd);

        if (paid) {
          await interaction.followUp({ content: `✅ Payment detected for trade #${tradeId}!`, ephemeral: true });
        } else {
          await interaction.followUp({ content: `❌ No payment yet for trade #${tradeId}. Address: \`${trade.depositAddress}\` Expected: $${totalUsd.toFixed(4)}`, ephemeral: true });
        }
        return;
      }

      if (commandName === 'panel') {
        const embed = new EmbedBuilder()
          .setTitle('Create a Ticket')
          .setDescription('Please select a category from the dropdown below to create a new ticket.')
          .setColor('Blurple');

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('create_ticket')
          .setPlaceholder('Select a category...')
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel('Litecoin')
              .setDescription('Create a Litecoin middleman trade')
              .setValue('litecoin')
              .setEmoji('🪙')
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        return interaction.reply({ embeds: [embed], components: [row] });
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'create_ticket') {
        const selected = interaction.values[0];

        if (selected === 'litecoin') {
          const modal = new ModalBuilder()
            .setCustomId('enter_user_modal')
            .setTitle('Enter Other User ID');

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('otherUserId')
                .setLabel('Other User Discord ID')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('123456789012345678')
                .setRequired(true)
            )
          );

          return interaction.showModal(modal);
        }
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('confirm_sendall_')) {
        const parts = interaction.customId.split('_');
        const index = parseInt(parts[2]);
        const address = parts[3];
        
        await interaction.update({ content: '⏳ Processing...', components: [], embeds: [] });

        try {
          const result = await sendAllLTC(address, index);
          
          if (result.success) {
            const embed = new EmbedBuilder()
              .setTitle('✅ Withdrawal Complete')
              .setColor('Green')
              .addFields(
                { name: 'Amount Sent', value: `${result.amountSent || '?'} LTC`, inline: true },
                { name: 'From Index', value: `${index}`, inline: true },
                { name: 'Destination', value: `\`${address}\``, inline: false },
                { name: 'Transaction ID', value: `\`${result.txid}\``, inline: false }
              );

            await interaction.editReply({ embeds: [embed] });
            await log(interaction.guild, `💸 Owner withdrew LTC from index ${index} to \`${address}\` | TxID: ${result.txid}`);
          } else {
            await interaction.editReply({ content: `❌ Withdrawal failed: ${result.error}` });
          }
        } catch (err) {
          console.error('Withdrawal error:', err);
          await interaction.editReply({ content: '❌ Withdrawal failed. Check console.' });
        }
        return;
      }

      if (interaction.customId === 'cancel_sendall') {
        await interaction.update({ content: '❌ Withdrawal cancelled.', components: [], embeds: [] });
        return;
      }

      if (interaction.customId.startsWith('role_sending_')) {
        const tradeId = interaction.customId.split('_')[2];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
          return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
        }

        if (trade.senderId && trade.senderId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Sending role already taken!', ephemeral: true });
        }

        db.prepare(`UPDATE trades SET senderId = ? WHERE id = ?`).run(interaction.user.id, tradeId);

        await interaction.reply({ content: `✅ <@${interaction.user.id}> selected **Sending** (will pay LTC)!` });

        const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        if (updated.senderId && updated.receiverId) {
          await sendRoleConfirmation(interaction.channel, tradeId);
        }
        return;
      }

      if (interaction.customId.startsWith('role_receiving_')) {
        const tradeId = interaction.customId.split('_')[2];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
          return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
        }

        if (trade.receiverId && trade.receiverId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Receiving role already taken!', ephemeral: true });
        }

        db.prepare(`UPDATE trades SET receiverId = ? WHERE id = ?`).run(interaction.user.id, tradeId);

        await interaction.reply({ content: `✅ <@${interaction.user.id}> selected **Receiving** (will get LTC)!` });

        const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        if (updated.senderId && updated.receiverId) {
          await sendRoleConfirmation(interaction.channel, tradeId);
        }
        return;
      }

      if (interaction.customId.startsWith('confirm_roles_')) {
        const tradeId = interaction.customId.split('_')[2];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
          return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
        }

        const confirmKey = interaction.user.id === trade.user1Id ? 'user1Confirmed' : 'user2Confirmed';
        db.prepare(`UPDATE trades SET ${confirmKey} = 1 WHERE id = ?`).run(tradeId);

        await interaction.reply({ content: `✅ <@${interaction.user.id}> confirmed the roles!` });

        const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        if (updated.user1Confirmed && updated.user2Confirmed) {
          await promptForAmount(interaction.channel, tradeId);
        }
        return;
      }

      if (interaction.customId.startsWith('release_')) {
        const tradeId = interaction.customId.split('_')[1];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.senderId) {
          return interaction.reply({ content: '❌ Only the sender can initiate release!', ephemeral: true });
        }

        if (trade.status !== 'paid') {
          return interaction.reply({ content: '❌ Payment not confirmed yet.', ephemeral: true });
        }

        const receiver = await client.users.fetch(trade.receiverId).catch(() => null);
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`enter_receiver_address_${tradeId}`)
            .setLabel('Enter My LTC Address')
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({ 
          content: `📤 **Release Initiated!** <@${trade.senderId}> has initiated the release. ${receiver ? `<@${trade.receiverId}>` : 'Receiver'}, please click the button below to enter your LTC address:`,
          components: [row]
        });
        return;
      }

      if (interaction.customId.startsWith('enter_receiver_address_')) {
        const tradeId = interaction.customId.split('_')[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.receiverId) {
          return interaction.reply({ content: '❌ Only the receiver can enter their address!', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`receiver_address_modal_${tradeId}`)
          .setTitle('Enter Your LTC Address');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ltcAddress')
              .setLabel('Your Litecoin Address')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('ltc1...')
              .setRequired(true)
          )
        );

        return interaction.showModal(modal);
      }

      if (interaction.customId.startsWith('refund_')) {
        const tradeId = interaction.customId.split('_')[1];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.senderId && interaction.user.id !== trade.receiverId) {
          return interaction.reply({ content: '❌ Only trade participants can request a refund!', ephemeral: true });
        }

        if (!pendingRefunds.has(tradeId)) {
          pendingRefunds.set(tradeId, { senderConfirmed: false, receiverConfirmed: false });
        }

        const pending = pendingRefunds.get(tradeId);

        if (interaction.user.id === trade.senderId) {
          pending.senderConfirmed = true;
        } else if (interaction.user.id === trade.receiverId) {
          pending.receiverConfirmed = true;
        }

        await interaction.reply({ content: `✅ <@${interaction.user.id}> confirmed the refund request!` });

        if (pending.senderConfirmed && pending.receiverConfirmed) {
          pendingRefunds.delete(tradeId);
          
          await interaction.followUp({
            content: `✅ **Both parties confirmed refund!** <@${trade.senderId}>, please click below to enter your refund address:`,
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`enter_refund_address_${tradeId}`)
                  .setLabel('Enter Refund Address')
                  .setStyle(ButtonStyle.Danger)
              )
            ]
          });
        } else {
          const otherId = interaction.user.id === trade.senderId ? trade.receiverId : trade.senderId;
          await interaction.followUp({ content: `⏳ Waiting for <@${otherId}> to also confirm the refund...` });
        }
        return;
      }

      if (interaction.customId.startsWith('enter_refund_address_')) {
        const tradeId = interaction.customId.split('_')[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.senderId) {
          return interaction.reply({ content: '❌ Only the sender can enter the refund address!', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`refund_address_modal_${tradeId}`)
          .setTitle('Enter Refund LTC Address');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ltcAddress')
              .setLabel('Your LTC Address')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('ltc1...')
              .setRequired(true)
          )
        );

        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'enter_user_modal') {
        const otherUserId = interaction.fields.getTextInputValue('otherUserId').trim();

        let otherMember;
        try {
          otherMember = await interaction.guild.members.fetch(otherUserId);
        } catch {
          return interaction.reply({ content: '❌ Invalid user ID. User must be in this server.', ephemeral: true });
        }

        if (otherUserId === interaction.user.id) {
          return interaction.reply({ content: '❌ You cannot trade with yourself.', ephemeral: true });
        }

        const tradeId = (db.prepare(`SELECT MAX(id) as maxId FROM trades`).get().maxId || 0) + 1;

        const channel = await interaction.guild.channels.create({
          name: `trade-${tradeId}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: interaction.guild.roles.everyone.id,
              deny: [PermissionsBitField.Flags.ViewChannel]
            },
            {
              id: interaction.user.id,
              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
            },
            {
              id: otherUserId,
              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
            },
            {
              id: OWNER_ID,
              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels]
            }
          ],
        });

        db.prepare(`INSERT INTO trades(id, channelId, user1Id, user2Id, status) VALUES(?,?,?,?,?)`).run(tradeId, channel.id, interaction.user.id, otherUserId, 'selecting_roles');

        await interaction.reply({ content: `✅ Trade channel created: ${channel}`, ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle('🪙 Litecoin Trade')
          .setDescription('Please select your role in this trade:')
          .setColor('Gold');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`role_sending_${tradeId}`)
            .setLabel('Sending (I pay LTC)')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`role_receiving_${tradeId}`)
            .setLabel('Receiving (I get LTC)')
            .setStyle(ButtonStyle.Success)
        );

        await channel.send({
          content: `<@${interaction.user.id}> <@${otherUserId}>`,
          embeds: [embed],
          components: [row]
        });

        await log(interaction.guild, `🆕 Trade #${tradeId} created by ${interaction.user.tag}`);
        return;
      }

      if (interaction.customId.startsWith('amount_modal_')) {
        const tradeId = interaction.customId.split('_')[2];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.senderId) {
          return interaction.reply({ content: '❌ Only the sender can enter the amount.', ephemeral: true });
        }

        const amountStr = interaction.fields.getTextInputValue('amount').trim();
        const amount = parseFloat(amountStr);

        if (isNaN(amount) || amount <= 0) {
          return interaction.reply({ content: '❌ Invalid amount.', ephemeral: true });
        }

        const feePercent = await getFeePercent();
        const fee = calculateFee(amount, feePercent);
        const total = amount + fee;

        const ltcPrice = await getLtcPriceUSD();
        const ltcAmount = (amount / ltcPrice).toFixed(8);
        const totalLtc = (total / ltcPrice).toFixed(8);

        const depositAddress = generateAddress(tradeId);

        db.prepare(`UPDATE trades SET amount = ?, fee = ?, ltcPrice = ?, ltcAmount = ?, totalLtc = ?, depositAddress = ?, status = 'awaiting_payment' WHERE id = ?`).run(amount, fee, ltcPrice, ltcAmount, totalLtc, depositAddress, tradeId);

        await interaction.reply({ content: '✅ Amount set! Generating invoice...', ephemeral: true });

        const qrPath = path.join(__dirname, 'temp', `qr_${tradeId}.png`);
        if (!fs.existsSync(path.join(__dirname, 'temp'))) {
          fs.mkdirSync(path.join(__dirname, 'temp'));
        }

        await QRCode.toFile(qrPath, `litecoin:${depositAddress}?amount=${totalLtc}`);

        const embed = new EmbedBuilder()
          .setTitle('💳 Payment Invoice')
          .setDescription(`**Send exactly ${totalLtc} LTC to the address below**`)
          .setColor('Blue')
          .addFields(
            { name: '📦 Trade Amount', value: `$${amount}`, inline: true },
            { name: '💸 Fee', value: `$${fee.toFixed(2)} (${feePercent}%)`, inline: true },
            { name: '💰 TOTAL TO SEND', value: `$${total.toFixed(2)}`, inline: true },
            { name: '⛓️ LTC Amount', value: `**${totalLtc} LTC**`, inline: true },
            { name: '💱 Exchange Rate', value: `$${ltcPrice}/LTC`, inline: true },
            { name: '📍 Deposit Address', value: `\`${depositAddress}\``, inline: false }
          )
          .setFooter({ text: 'Scan QR code or copy address. Send exact amount!' })
          .setImage(`attachment://qr_${tradeId}.png`);

        await interaction.channel.send({
          content: `<@${trade.senderId}> **Please send the TOTAL amount including fee:** ⏳ **Waiting for transaction...**`,
          embeds: [embed],
          files: [{ attachment: qrPath, name: `qr_${tradeId}.png` }]
        });

        setTimeout(() => {
          fs.unlink(qrPath, () => {});
        }, 5000);

        startPaymentMonitor(tradeId, trade.channelId, total);
        return;
      }

      if (interaction.customId.startsWith('receiver_address_modal_')) {
        const tradeId = interaction.customId.split('_')[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        const ltcAddress = interaction.fields.getTextInputValue('ltcAddress').trim();

        if (!ltcAddress.startsWith('ltc1') && !ltcAddress.startsWith('L') && !ltcAddress.startsWith('M')) {
          return interaction.reply({ content: '❌ Invalid Litecoin address.', ephemeral: true });
        }

        pendingReleases.set(tradeId, { 
          senderConfirmed: true, 
          receiverAddress: ltcAddress 
        });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_release_${tradeId}_${ltcAddress}`)
            .setLabel('✅ Yes, Send to This Address')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`cancel_release_${tradeId}`)
            .setLabel('❌ No, Wrong Address')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          content: `📤 **Confirm Your Address** <@${trade.receiverId}>, you entered: \`${ltcAddress}\` **Amount to receive:** ${trade.ltcAmount} LTC (≈$${trade.amount}) Is this correct? Click **Yes** to receive funds, or **No** to re-enter:`,
          components: [row]
        });
        return;
      }

      if (interaction.customId.startsWith('refund_address_modal_')) {
        const tradeId = interaction.customId.split('_')[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        const ltcAddress = interaction.fields.getTextInputValue('ltcAddress').trim();

        if (!ltcAddress.startsWith('ltc1') && !ltcAddress.startsWith('L') && !ltcAddress.startsWith('M')) {
          return interaction.reply({ content: '❌ Invalid Litecoin address.', ephemeral: true });
        }

        db.prepare(`UPDATE trades SET senderAddress = ? WHERE id = ?`).run(ltcAddress, tradeId);

        const totalLtc = ((trade.amount + trade.fee) / trade.ltcPrice).toFixed(8);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_refund_${tradeId}_${ltcAddress}`)
            .setLabel('Confirm Refund')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          content: `↩️ **Confirm Refund** Refunding **${totalLtc} LTC** to: \`${ltcAddress}\` <@${trade.senderId}>, click below to proceed:`,
          components: [row]
        });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('confirm_release_')) {
        const parts = interaction.customId.split('_');
        const tradeId = parts[2];
        const ltcAddress = parts[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        if (interaction.user.id !== trade.receiverId) {
          return interaction.reply({ content: '❌ Only the receiver can confirm their address!', ephemeral: true });
        }

        await interaction.update({ content: '⏳ Processing transaction...', components: [] });

        try {
          const feeLtc = (trade.fee / trade.ltcPrice).toFixed(8);
          
          const result = await sendLTC(tradeId, ltcAddress, trade.ltcAmount);

          if (result.success) {
            await sendFeeToAddress(FEE_ADDRESS, feeLtc, tradeId);

            db.prepare(`UPDATE trades SET status = 'completed', completedAt = datetime('now'), receiverAddress = ? WHERE id = ?`).run(ltcAddress, tradeId);
            stopPaymentMonitor(tradeId);
            pendingReleases.delete(tradeId);

            await interaction.followUp({
              content: `✅ **Transaction Complete!** Amount Sent: ${trade.ltcAmount} LTC | Fee: ${feeLtc} LTC | To: \`${ltcAddress}\` | TxID: \`${result.txid}\` The receiver should receive the funds shortly.`
            });

            await interaction.channel.send(`🎉 **Trade #${tradeId} completed successfully!**`);
            await log(interaction.guild, `✅ Trade #${tradeId} completed - ${trade.ltcAmount} LTC sent`);

            setTimeout(() => {
              interaction.channel.delete().catch(() => {});
            }, 120000);
          } else {
            await interaction.followUp({ content: `❌ Transaction failed: ${result.error}` });
          }
        } catch (err) {
          console.error('Send error:', err);
          await interaction.followUp({ content: '❌ Transaction failed. Please contact an administrator.' });
        }
        return;
      }

      if (interaction.customId.startsWith('cancel_release_')) {
        const tradeId = interaction.customId.split('_')[2];
        pendingReleases.delete(tradeId);
        
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`enter_receiver_address_${tradeId}`)
            .setLabel('Enter My LTC Address')
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.update({ 
          content: `❌ Cancelled. <@${trade.receiverId}>, please click below to re-enter your address:`, 
          components: [row] 
        });
        return;
      }

      if (interaction.customId.startsWith('confirm_refund_')) {
        const parts = interaction.customId.split('_');
        const tradeId = parts[2];
        const ltcAddress = parts[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

        await interaction.update({ content: '⏳ Processing refund...', components: [] });

        try {
          const totalLtc = ((trade.amount + trade.fee) / trade.ltcPrice).toFixed(8);
          const result = await sendLTC(tradeId, ltcAddress, totalLtc);

          if (result.success) {
            db.prepare(`UPDATE trades SET status = 'refunded', refundedAt = datetime('now'), refundAddress = ? WHERE id = ?`).run(ltcAddress, tradeId);
            stopPaymentMonitor(tradeId);

            await interaction.followUp({
              content: `↩️ **Refund Complete!** Amount Refunded: ${totalLtc} LTC | To: \`${ltcAddress}\` | TxID: \`${result.txid}\` You should receive the refund shortly.`
            });

            await interaction.channel.send(`↩️ **Trade #${tradeId} refunded.**`);
            await log(interaction.guild, `↩️ Trade #${tradeId} refunded - ${totalLtc} LTC returned`);

            setTimeout(() => {
              interaction.channel.delete().catch(() => {});
            }, 60000);
          } else {
            await interaction.followUp({ content: `❌ Refund failed: ${result.error}` });
          }
        } catch (err) {
          console.error('Refund error:', err);
          await interaction.followUp({ content: '❌ Refund failed. Please contact an administrator.' });
        }
        return;
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '❌ An error occurred.', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
      }
    } catch {}
  }
});

async function sendRoleConfirmation(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const sender = await client.users.fetch(trade.senderId).catch(() => null);
  const receiver = await client.users.fetch(trade.receiverId).catch(() => null);

  const embed = new EmbedBuilder()
    .setTitle('✅ Roles Selected')
    .setDescription('Please confirm the roles are correct:')
    .setColor('Green')
    .addFields(
      { name: 'Sender (pays LTC)', value: sender ? sender.tag : 'Unknown', inline: true },
      { name: 'Receiver (gets LTC)', value: receiver ? receiver.tag : 'Unknown', inline: true }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_roles_${tradeId}`)
      .setLabel('Correct')
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({
    content: `<@${trade.user1Id}> <@${trade.user2Id}> Please confirm:`,
    embeds: [embed],
    components: [row]
  });
}

async function promptForAmount(channel, tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

  const embed = new EmbedBuilder()
    .setTitle('💰 Enter Amount')
    .setDescription(`<@${trade.senderId}>, please enter the USD amount to trade.`)
    .setColor('Blue');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`enter_amount_${tradeId}`)
      .setLabel('Enter Amount')
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith('enter_amount_')) {
    const tradeId = interaction.customId.split('_')[2];
    const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

    if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });

    if (interaction.user.id !== trade.senderId) {
      return interaction.reply({ content: '❌ Only the sender can enter the amount.', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`amount_modal_${tradeId}`)
      .setTitle('Enter Trade Amount');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Amount in USD')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('100')
          .setRequired(true)
      )
    );

    await interaction.showModal(modal);
  }
});

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
