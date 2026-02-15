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
const { initWallet, generateAddress, sendLTC, getWalletBalance } = require('./wallet');
const { checkPayment, getLtcPriceUSD } = require('./blockchain');
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

// Bot config
const OWNER_ID = process.env.OWNER_ID;
const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID; // Add this to your .env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN || !OWNER_ID || !process.env.BOT_MNEMONIC) {
  console.error('Missing required environment variables. Check your .env file.');
  process.exit(1);
}

initWallet(process.env.BOT_MNEMONIC);

// Active payment monitors (tradeId -> intervalId)
const activeMonitors = new Map();

// Helper: Check if user has owner permissions (either by user ID or owner role)
async function hasOwnerPermissions(userId, member) {
  // Check if user is the owner by ID
  if (userId === OWNER_ID) return true;
  
  // Check if user has the owner role (if configured)
  if (OWNER_ROLE_ID && member) {
    return member.roles.cache.has(OWNER_ROLE_ID);
  }
  
  return false;
}

// ---------- Register Slash Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Show the trading panel'),
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
  // NEW: /send command
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send all LTC to an address (Owner only)')
    .addStringOption((opt) =>
      opt.setName('address').setDescription('Litecoin address to send to').setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

// ---------- Utilities ----------
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

// ---------- Payment Monitoring ----------
function startPaymentMonitor(tradeId, channelId, expectedUsd) {
  if (activeMonitors.has(tradeId)) return;

  console.log(`[Monitor] Starting payment monitor for trade ${tradeId}, expecting $${expectedUsd}`);

  const intervalId = setInterval(async () => {
    try {
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
      if (!trade || trade.status === 'completed' || trade.status === 'cancelled' || trade.status === 'refunded') {
        stopPaymentMonitor(tradeId);
        return;
      }

      const paid = await checkPayment(trade.depositAddress, expectedUsd);

      if (paid && trade.status === 'awaiting_payment') {
        db.prepare(`UPDATE trades SET status = 'paid', paidAt = datetime('now') WHERE id = ?`).run(tradeId);

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
            content: `✅ **Found transaction!**\n\n` +
                    `**Sender:** ${sender ? sender.tag : 'Unknown'}\n` +
                    `**Receiver:** ${receiver ? receiver.tag : 'Unknown'}\n\n` +
                    `Payment confirmed. Click **Release** to send funds to receiver, or **Refund** to return to sender.`,
            components: [row]
          });

          await log(channel.guild, `✅ Trade #${tradeId} payment confirmed, awaiting release`);
        }
      }
    } catch (err) {
      console.error(`[Monitor] Error checking payment for trade ${tradeId}:`, err);
    }
  }, 20000);

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

// ---------- Client Ready ----------
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

  // Resume monitoring for active trades
  const activeTrades = db.prepare(`SELECT * FROM trades WHERE status IN ('awaiting_payment', 'paid')`).all();
  for (const trade of activeTrades) {
    if (trade.amount && trade.amount > 0) {
      const totalUsd = trade.amount + trade.fee;
      startPaymentMonitor(trade.id, trade.channelId, totalUsd);
    }
  }
});

// ---------- Interactions ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ----- Slash commands -----
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // NEW: /send command handler
      if (commandName === 'send') {
        // Check owner permissions (by user ID or owner role)
        const hasPermission = await hasOwnerPermissions(interaction.user.id, interaction.member);
        
        if (!hasPermission) {
          return interaction.reply({ content: '❌ Only the owner or users with the owner role can use this command.', flags: 64 });
        }

        const address = interaction.options.getString('address').trim();

        // Validate LTC address
        if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M')) {
          return interaction.reply({ content: '❌ Invalid Litecoin address. Must start with ltc1, L, or M.', flags: 64 });
        }

        // Get wallet balance
        const balance = await getWalletBalance();
        
        if (!balance || balance <= 0) {
          return interaction.reply({ content: '❌ Wallet is empty. No LTC to send.', flags: 64 });
        }

        // Create confirmation embed
        const ltcPrice = await getLtcPriceUSD();
        const usdValue = (balance * ltcPrice).toFixed(2);

        const embed = new EmbedBuilder()
          .setTitle('⚠️ Confirm LTC Transfer')
          .setDescription('You are about to send **ALL** LTC from the bot wallet.')
          .setColor('Orange')
          .addFields(
            { name: 'Amount to Send', value: `${balance} LTC`, inline: true },
            { name: 'USD Value', value: `~$${usdValue}`, inline: true },
            { name: 'Destination', value: `\`${address}\``, inline: false },
            { name: 'Warning', value: 'This action cannot be undone!' }
          );

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_sendall_${address}`)
            .setLabel('Confirm Send All')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`cancel_sendall`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({ 
          embeds: [embed], 
          components: [confirmRow],
          flags: 64 
        });
      }

      if (commandName === 'logchannel') {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Only owner can use this.', flags: 64 });
        }

        const id = interaction.options.getString('channelid');
        const channel = await interaction.guild.channels.fetch(id).catch(() => null);

        if (!channel) {
          return interaction.reply({ content: '❌ Invalid channel ID.', flags: 64 });
        }

        db.prepare(`INSERT OR REPLACE INTO config(key,value) VALUES('logChannel',?)`).run(id);
        return interaction.reply({ content: `✅ Log channel set to ${channel}.`, flags: 64 });
      }

      if (commandName === 'setfee') {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Only owner can use this.', flags: 64 });
        }

        const percent = interaction.options.getNumber('percentage');
        if (percent < 0 || percent > 50) {
          return interaction.reply({ content: '❌ Fee must be between 0% and 50%.', flags: 64 });
        }

        db.prepare(`INSERT OR REPLACE INTO config(key,value) VALUES('feePercent',?)`).run(percent.toString());
        return interaction.reply({ content: `✅ Fee set to ${percent}%.`, flags: 64 });
      }

      if (commandName === 'check') {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Only owner can use this.', flags: 64 });
        }

        const tradeId = interaction.options.getString('tradeid');
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) {
          return interaction.reply({ content: '❌ Trade not found.', flags: 64 });
        }

        await interaction.reply({ content: `🔍 Checking trade #${tradeId}...`, flags: 64 });

        const totalUsd = trade.amount + trade.fee;
        const paid = await checkPayment(trade.depositAddress, totalUsd);

        if (paid) {
          await interaction.followUp({ content: `✅ Payment detected for trade #${tradeId}!`, flags: 64 });
        } else {
          await interaction.followUp({ content: `❌ No payment yet for trade #${tradeId}.\nAddress: \`${trade.depositAddress}\`\nExpected: $${totalUsd.toFixed(4)}`, flags: 64 });
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

    // ----- Select Menu -----
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

    // ----- Button Interactions -----
    if (interaction.isButton()) {
      // NEW: Handle /send confirmations
      if (interaction.customId.startsWith('confirm_sendall_')) {
        const hasPermission = await hasOwnerPermissions(interaction.user.id, interaction.member);
        if (!hasPermission) {
          return interaction.reply({ content: '❌ Only owner can confirm this.', flags: 64 });
        }

        const address = interaction.customId.split('_')[2];
        
        await interaction.update({ content: '⏳ Processing withdrawal...', components: [], embeds: [] });

        try {
          const balance = await getWalletBalance();
          const result = await sendLTC('withdrawal', address, balance);

          if (result.success) {
            const embed = new EmbedBuilder()
              .setTitle('✅ Withdrawal Complete')
              .setDescription(`Successfully sent all LTC to the specified address.`)
              .setColor('Green')
              .addFields(
                { name: 'Amount Sent', value: `${balance} LTC`, inline: true },
                { name: 'Destination', value: `\`${address}\``, inline: false },
                { name: 'Transaction ID', value: `\`${result.txid}\``, inline: false }
              );

            await interaction.followUp({ embeds: [embed], flags: 64 });
            
            // Log the withdrawal
            await log(interaction.guild, `💸 Owner withdrew ${balance} LTC to \`${address}\` | TxID: ${result.txid}`);
          } else {
            await interaction.followUp({ content: `❌ Withdrawal failed: ${result.error}`, flags: 64 });
          }
        } catch (err) {
          console.error('Withdrawal error:', err);
          await interaction.followUp({ content: '❌ Withdrawal failed. Check console for details.', flags: 64 });
        }
        return;
      }

      if (interaction.customId === 'cancel_sendall') {
        await interaction.update({ content: '❌ Withdrawal cancelled.', components: [], embeds: [] });
        return;
      }

      // Role selection - Sending
      if (interaction.customId.startsWith('role_sending_')) {
        const tradeId = interaction.customId.split('_')[2];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
          return interaction.reply({ content: '❌ You are not part of this trade.', flags: 64 });
        }

        if (trade.senderId && trade.senderId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Sending role already taken!', flags: 64 });
        }

        db.prepare(`UPDATE trades SET senderId = ? WHERE id = ?`).run(interaction.user.id, tradeId);

        await interaction.reply({ content: '✅ You selected **Sending**!', flags: 64 });

        const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        if (updated.senderId && updated.receiverId) {
          await sendRoleConfirmation(interaction.channel, tradeId);
        }
        return;
      }

      // Role selection - Receiving
      if (interaction.customId.startsWith('role_receiving_')) {
        const tradeId = interaction.customId.split('_')[2];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
          return interaction.reply({ content: '❌ You are not part of this trade.', flags: 64 });
        }

        if (trade.receiverId && trade.receiverId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Receiving role already taken!', flags: 64 });
        }

        db.prepare(`UPDATE trades SET receiverId = ? WHERE id = ?`).run(interaction.user.id, tradeId);

        await interaction.reply({ content: '✅ You selected **Receiving**!', flags: 64 });

        const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        if (updated.senderId && updated.receiverId) {
          await sendRoleConfirmation(interaction.channel, tradeId);
        }
        return;
      }

      // Confirm roles
      if (interaction.customId.startsWith('confirm_roles_')) {
        const tradeId = interaction.customId.split('_')[2];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        if (interaction.user.id !== trade.user1Id && interaction.user.id !== trade.user2Id) {
          return interaction.reply({ content: '❌ You are not part of this trade.', flags: 64 });
        }

        const confirmKey = interaction.user.id === trade.user1Id ? 'user1Confirmed' : 'user2Confirmed';
        db.prepare(`UPDATE trades SET ${confirmKey} = 1 WHERE id = ?`).run(tradeId);

        await interaction.reply({ content: '✅ Roles confirmed!', flags: 64 });

        const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        if (updated.user1Confirmed && updated.user2Confirmed) {
          await promptForAmount(interaction.channel, tradeId);
        }
        return;
      }

      // Release funds - ONLY SENDER CAN CLICK
      if (interaction.customId.startsWith('release_')) {
        const tradeId = interaction.customId.split('_')[1];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        if (interaction.user.id !== trade.senderId) {
          return interaction.reply({ content: '❌ Only the sender can release funds!', flags: 64 });
        }

        if (trade.status !== 'paid') {
          return interaction.reply({ content: '❌ Payment not confirmed yet.', flags: 64 });
        }

        const modal = new ModalBuilder()
          .setCustomId(`release_address_modal_${tradeId}`)
          .setTitle('Enter Receiver LTC Address');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ltcAddress')
              .setLabel('Litecoin Address (for receiver)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('ltc1...')
              .setRequired(true)
          )
        );

        return interaction.showModal(modal);
      }

      // Refund - ONLY SENDER CAN CLICK
      if (interaction.customId.startsWith('refund_')) {
        const tradeId = interaction.customId.split('_')[1];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        if (interaction.user.id !== trade.senderId) {
          return interaction.reply({ content: '❌ Only the sender can request a refund!', flags: 64 });
        }

        const modal = new ModalBuilder()
          .setCustomId(`refund_address_modal_${tradeId}`)
          .setTitle('Enter Your LTC Address for Refund');

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
    }

    // ----- Modal Submit -----
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'enter_user_modal') {
        const otherUserId = interaction.fields.getTextInputValue('otherUserId').trim();

        let otherMember;
        try {
          otherMember = await interaction.guild.members.fetch(otherUserId);
        } catch {
          return interaction.reply({ content: '❌ Invalid user ID. User must be in this server.', flags: 64 });
        }

        if (otherUserId === interaction.user.id) {
          return interaction.reply({ content: '❌ You cannot trade with yourself.', flags: 64 });
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

        db.prepare(
          `INSERT INTO trades(id, channelId, user1Id, user2Id, status) VALUES(?,?,?,?,?)`
        ).run(tradeId, channel.id, interaction.user.id, otherUserId, 'selecting_roles');

        await interaction.reply({ content: `✅ Trade channel created: ${channel}`, flags: 64 });

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

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        if (interaction.user.id !== trade.senderId) {
          return interaction.reply({ content: '❌ Only the sender can enter the amount.', flags: 64 });
        }

        const amountStr = interaction.fields.getTextInputValue('amount').trim();
        const amount = parseFloat(amountStr);

        if (isNaN(amount) || amount <= 0) {
          return interaction.reply({ content: '❌ Invalid amount.', flags: 64 });
        }

        const feePercent = await getFeePercent();
        const fee = calculateFee(amount, feePercent);
        const total = amount + fee;

        const ltcPrice = await getLtcPriceUSD();
        const ltcAmount = (amount / ltcPrice).toFixed(8);
        const totalLtc = (total / ltcPrice).toFixed(8);

        const depositAddress = generateAddress(tradeId);

        db.prepare(
          `UPDATE trades SET amount = ?, fee = ?, ltcPrice = ?, ltcAmount = ?, totalLtc = ?, depositAddress = ?, status = 'awaiting_payment' WHERE id = ?`
        ).run(amount, fee, ltcPrice, ltcAmount, totalLtc, depositAddress, tradeId);

        await interaction.reply({ content: '✅ Amount set! Generating invoice...', flags: 64 });

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
          content: `<@${trade.senderId}> **Please send the TOTAL amount including fee:**`,
          embeds: [embed],
          files: [{ attachment: qrPath, name: `qr_${tradeId}.png` }]
        });

        setTimeout(() => {
          fs.unlink(qrPath, () => {});
        }, 5000);

        startPaymentMonitor(tradeId, trade.channelId, total);
        return;
      }

      if (interaction.customId.startsWith('release_address_modal_')) {
        const tradeId = interaction.customId.split('_')[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        const ltcAddress = interaction.fields.getTextInputValue('ltcAddress').trim();

        if (!ltcAddress.startsWith('ltc1') && !ltcAddress.startsWith('L') && !ltcAddress.startsWith('M')) {
          return interaction.reply({ content: '❌ Invalid Litecoin address.', flags: 64 });
        }

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_send_${tradeId}_${ltcAddress}`)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success)
        );

        await interaction.reply({
          content: `📤 **Confirm Transaction**\n\n` +
                  `Sending **${trade.ltcAmount} LTC** (≈$${trade.amount}) to:\n` +
                  `\`${ltcAddress}\`\n\n` +
                  `Click **Confirm** to proceed.`,
          components: [confirmRow],
          flags: 64
        });
        return;
      }

      if (interaction.customId.startsWith('refund_address_modal_')) {
        const tradeId = interaction.customId.split('_')[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        const ltcAddress = interaction.fields.getTextInputValue('ltcAddress').trim();

        if (!ltcAddress.startsWith('ltc1') && !ltcAddress.startsWith('L') && !ltcAddress.startsWith('M')) {
          return interaction.reply({ content: '❌ Invalid Litecoin address.', flags: 64 });
        }

        const totalLtc = ((trade.amount + trade.fee) / trade.ltcPrice).toFixed(8);

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_refund_${tradeId}_${ltcAddress}`)
            .setLabel('Confirm Refund')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          content: `↩️ **Confirm Refund**\n\n` +
                  `Refunding **${totalLtc} LTC** to:\n` +
                  `\`${ltcAddress}\`\n\n` +
                  `Click **Confirm Refund** to proceed.`,
          components: [confirmRow],
          flags: 64
        });
        return;
      }
    }

    // ----- Confirm Send/Refund Buttons -----
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('confirm_send_')) {
        const parts = interaction.customId.split('_');
        const tradeId = parts[2];
        const ltcAddress = parts[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        await interaction.update({ content: '⏳ Processing transaction...', components: [] });

        try {
          const result = await sendLTC(tradeId, ltcAddress, trade.ltcAmount);

          if (result.success) {
            db.prepare(`UPDATE trades SET status = 'completed', completedAt = datetime('now'), receiverAddress = ? WHERE id = ?`).run(ltcAddress, tradeId);
            stopPaymentMonitor(tradeId);

            await interaction.followUp({
              content: `✅ **Transaction Complete!**\n\n` +
                      `**Amount Sent:** ${trade.ltcAmount} LTC\n` +
                      `**To:** \`${ltcAddress}\`\n` +
                      `**TxID:** \`${result.txid}\`\n\n` +
                      `The receiver should receive the funds shortly.`,
              flags: 64
            });

            await interaction.channel.send(`🎉 **Trade #${tradeId} completed successfully!**`);
            await log(interaction.guild, `✅ Trade #${tradeId} completed - ${trade.ltcAmount} LTC sent`);

            setTimeout(() => {
              interaction.channel.delete().catch(() => {});
            }, 120000);
          } else {
            await interaction.followUp({ content: `❌ Transaction failed: ${result.error}`, flags: 64 });
          }
        } catch (err) {
          console.error('Send error:', err);
          await interaction.followUp({ content: '❌ Transaction failed. Please contact an administrator.', flags: 64 });
        }
        return;
      }

      if (interaction.customId.startsWith('confirm_refund_')) {
        const parts = interaction.customId.split('_');
        const tradeId = parts[2];
        const ltcAddress = parts[3];
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

        if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

        await interaction.update({ content: '⏳ Processing refund...', components: [] });

        try {
          const totalLtc = ((trade.amount + trade.fee) / trade.ltcPrice).toFixed(8);
          const result = await sendLTC(tradeId, ltcAddress, totalLtc);

          if (result.success) {
            db.prepare(`UPDATE trades SET status = 'refunded', refundedAt = datetime('now'), refundAddress = ? WHERE id = ?`).run(ltcAddress, tradeId);
            stopPaymentMonitor(tradeId);

            await interaction.followUp({
              content: `↩️ **Refund Complete!**\n\n` +
                      `**Amount Refunded:** ${totalLtc} LTC\n` +
                      `**To:** \`${ltcAddress}\`\n` +
                      `**TxID:** \`${result.txid}\`\n\n` +
                      `You should receive the refund shortly.`,
              flags: 64
            });

            await interaction.channel.send(`↩️ **Trade #${tradeId} refunded.**`);
            await log(interaction.guild, `↩️ Trade #${tradeId} refunded - ${totalLtc} LTC returned`);

            setTimeout(() => {
              interaction.channel.delete().catch(() => {});
            }, 60000);
          } else {
            await interaction.followUp({ content: `❌ Refund failed: ${result.error}`, flags: 64 });
          }
        } catch (err) {
          console.error('Refund error:', err);
          await interaction.followUp({ content: '❌ Refund failed. Please contact an administrator.', flags: 64 });
        }
        return;
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '❌ An error occurred.', flags: 64 });
      } else {
        await interaction.reply({ content: '❌ An error occurred.', flags: 64 });
      }
    } catch {}
  }
});

// Helper: Send role confirmation message
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

// Helper: Prompt for amount
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

// Handle enter amount button
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith('enter_amount_')) {
    const tradeId = interaction.customId.split('_')[2];
    const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

    if (!trade) return interaction.reply({ content: 'Trade not found.', flags: 64 });

    if (interaction.user.id !== trade.senderId) {
      return interaction.reply({ content: '❌ Only the sender can enter the amount.', flags: 64 });
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  activeMonitors.forEach((id) => clearInterval(id));
  client.destroy();
  process.exit(0);
});

// ---------- Login ----------
client.login(DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login:', err);
  process.exit(1);
});
