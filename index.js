require('dotenv').config();

// ============================================
// ENVIRONMENT CHECK
// ============================================
console.log('🔍 Checking environment variables...');
console.log('DISCORD_TOKEN exists:', !!process.env.DISCORD_TOKEN);
console.log('WALLET_MNEMONIC exists:', !!process.env.WALLET_MNEMONIC);
console.log('CLIENT_ID exists:', !!process.env.CLIENT_ID);
console.log('BLOCKCYPHER_TOKEN exists:', !!process.env.BLOCKCYPHER_TOKEN);

if (!process.env.WALLET_MNEMONIC) {
  console.error('❌ FATAL: WALLET_MNEMONIC not found!');
  console.error('Add to .env: WALLET_MNEMONIC=word1 word2 word3...');
  process.exit(1);
}
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ FATAL: DISCORD_TOKEN not found!');
  process.exit(1);
}

// ============================================
// IMPORTS
// ============================================
const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  Routes,
  REST,
  ChannelType,
  ComponentType
} = require('discord.js');
const db = require('./database');
const { getAddress, getBalance, sendAllLTC, getWalletAtIndex0 } = require('./wallet');
const { getLtcPriceUSD, getAddressInfo, getTransaction } = require('./blockchain');
const fs = require('fs');
const path = require('path');

// ============================================
// CLIENT SETUP
// ============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// ============================================
// CONFIGURATION
// ============================================
const OWNER_ID = process.env.OWNER_ID || '1298640383688970293';
const FEE_LTC = 0.001;
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
const TICKET_CATEGORY = process.env.TICKET_CATEGORY || null;
const DEPOSIT_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const CONFIRMATION_TIMEOUT = 60 * 60 * 1000; // 1 hour

// ============================================
// STORAGE
// ============================================
const activeTickets = new Map();
const depositMonitors = new Map();
const userCooldowns = new Map();
const COOLDOWN_TIME = 5000; // 5 seconds

// ============================================
// COMMANDS DEFINITION
// ============================================
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Create middleman panel (Owner only)'),
  
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send all LTC from index 0 to address')
    .addStringOption(option => 
      option.setName('address')
        .setDescription('LTC address to send to')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check balance of index 0 wallet'),
  
  new SlashCommandBuilder()
    .setName('address')
    .setDescription('Get your index 0 LTC address'),
  
  new SlashCommandBuilder()
    .setName('release')
    .setDescription('Release funds to receiver (Owner only)')
    .addStringOption(option => 
      option.setName('channelid')
        .setDescription('Channel ID of the trade')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('receiver_address')
        .setDescription('Receiver LTC address')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('refund')
    .setDescription('Refund funds to sender (Owner only)')
    .addStringOption(option => 
      option.setName('channelid')
        .setDescription('Channel ID of the trade')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('sender_address')
        .setDescription('Sender LTC address for refund')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check status of current trade'),
  
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close trade channel (Owner only)')
    .addStringOption(option => 
      option.setName('channelid')
        .setDescription('Channel ID to close')
        .setRequired(true))
].map(command => command.toJSON());

// ============================================
// REST API SETUP
// ============================================
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// ============================================
// READY EVENT
// ============================================
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`✅ Bot ID: ${client.user.id}`);
  console.log(`✅ Using INDEX 0 ONLY - Single Address Mode`);
  console.log(`✅ Fee Address: ${FEE_ADDRESS}`);
  console.log(`✅ Owner ID: ${OWNER_ID}`);
  
  // Deploy commands
  try {
    console.log('🚀 Deploying slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Commands deployed successfully!');
  } catch (error) {
    console.error('❌ Error deploying commands:', error.message);
  }
  
  // Load active tickets from database
  await loadActiveTickets();
  
  // Start background tasks
  startBackgroundTasks();
});

// ============================================
// DATABASE FUNCTIONS
// ============================================
async function loadActiveTickets() {
  try {
    const stmt = db.prepare('SELECT * FROM tickets WHERE status IN (?, ?)');
    const tickets = stmt.all('waiting_deposit', 'funded');
    
    console.log(`📂 Loading ${tickets.length} active tickets from database...`);
    
    for (const ticket of tickets) {
      activeTickets.set(ticket.ticket_id, {
        id: ticket.ticket_id,
        sender: ticket.sender_id,
        receiver: ticket.receiver_id,
        giving: ticket.giving,
        receiving: ticket.receiving,
        ltcAmount: parseFloat(ticket.ltc_amount),
        escrowAddress: ticket.escrow_address,
        status: ticket.status,
        channelId: ticket.channel_id,
        messageId: ticket.message_id,
        depositTx: ticket.deposit_tx,
        createdAt: ticket.created_at,
        completedAt: ticket.completed_at
      });
      
      // Resume monitoring if waiting for deposit
      if (ticket.status === 'waiting_deposit') {
        const channel = client.channels.cache.get(ticket.channel_id);
        if (channel) {
          console.log(`🔄 Resuming monitoring for ticket ${ticket.ticket_id}`);
          monitorDeposit(ticket.ticket_id, channel, parseFloat(ticket.ltc_amount));
        } else {
          console.log(`⚠️ Channel not found for ticket ${ticket.ticket_id}, marking as expired`);
          updateTicketStatus(ticket.ticket_id, 'expired');
        }
      }
    }
    
    console.log(`✅ Loaded ${tickets.length} active tickets`);
  } catch (error) {
    console.error('❌ Error loading tickets:', error.message);
  }
}

function saveTicket(ticketData) {
  try {
    const stmt = db.prepare(`INSERT INTO tickets 
      (ticket_id, sender_id, receiver_id, giving, receiving, ltc_amount, escrow_address, status, channel_id, created_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(
      ticketData.id,
      ticketData.sender,
      ticketData.receiver,
      ticketData.giving,
      ticketData.receiving,
      ticketData.ltcAmount,
      ticketData.escrowAddress,
      ticketData.status,
      ticketData.channelId,
      ticketData.createdAt
    );
    return true;
  } catch (error) {
    console.error('❌ Error saving ticket:', error.message);
    return false;
  }
}

function updateTicketStatus(ticketId, status, data = {}) {
  try {
    const updates = ['status = ?'];
    const values = [status];
    
    if (data.depositAmount !== undefined) {
      updates.push('deposit_amount = ?');
      values.push(data.depositAmount);
    }
    if (data.txHash !== undefined) {
      updates.push('tx_hash = ?');
      values.push(data.txHash);
    }
    if (data.completedAt !== undefined) {
      updates.push('completed_at = ?');
      values.push(data.completedAt);
    }
    if (data.messageId !== undefined) {
      updates.push('message_id = ?');
      values.push(data.messageId);
    }
    
    values.push(ticketId);
    
    const stmt = db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE ticket_id = ?`);
    stmt.run(...values);
    return true;
  } catch (error) {
    console.error('❌ Error updating ticket:', error.message);
    return false;
  }
}

// ============================================
// COOLDOWN CHECK
// ============================================
function checkCooldown(userId) {
  const now = Date.now();
  const userCooldown = userCooldowns.get(userId);
  
  if (userCooldown && now - userCooldown < COOLDOWN_TIME) {
    const remaining = Math.ceil((COOLDOWN_TIME - (now - userCooldown)) / 1000);
    return { onCooldown: true, remaining };
  }
  
  userCooldowns.set(userId, now);
  return { onCooldown: false, remaining: 0 };
}

// ============================================
// INTERACTION HANDLER
// ============================================
client.on('interactionCreate', async (interaction) => {
  try {
    // Cooldown check for buttons
    if (interaction.isButton()) {
      const { onCooldown, remaining } = checkCooldown(interaction.user.id);
      if (onCooldown) {
        return interaction.reply({ 
          content: `⏳ Please wait ${remaining} seconds before clicking again.`, 
          ephemeral: true 
        });
      }
    }
    
    // Slash Commands
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    }
    // Button Interactions
    else if (interaction.isButton()) {
      await handleButton(interaction);
    }
    // Modal Submit
    else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
    // Select Menu
    else if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    }
    
  } catch (error) {
    console.error('❌ Interaction error:', error);
    const reply = { content: '❌ An unexpected error occurred. Please try again.', ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
});

// ============================================
// SLASH COMMAND HANDLER
// ============================================
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;
  
  switch (commandName) {
    case 'panel':
      await handlePanel(interaction);
      break;
    case 'send':
      await handleSend(interaction);
      break;
    case 'balance':
      await handleBalance(interaction);
      break;
    case 'address':
      await handleAddress(interaction);
      break;
    case 'release':
      await handleOwnerRelease(interaction);
      break;
    case 'refund':
      await handleOwnerRefund(interaction);
      break;
    case 'status':
      await handleStatus(interaction);
      break;
    case 'close':
      await handleClose(interaction);
      break;
    default:
      await interaction.reply({ content: '❌ Unknown command.', ephemeral: true });
  }
}

// ============================================
// BUTTON HANDLER
// ============================================
async function handleButton(interaction) {
  const { customId } = interaction;
  
  if (customId === 'create_ticket') {
    await showTicketModal(interaction);
  }
  else if (customId.startsWith('sender_release_')) {
    await handleSenderRelease(interaction);
  }
  else if (customId.startsWith('sender_refund_')) {
    await handleSenderRefund(interaction);
  }
  else if (customId.startsWith('receiver_confirm_')) {
    await handleReceiverConfirm(interaction);
  }
  else if (customId.startsWith('cancel_')) {
    await handleCancel(interaction);
  }
  else if (customId.startsWith('confirm_deposit_')) {
    await handleConfirmDeposit(interaction);
  }
  else {
    await interaction.reply({ content: '❌ Unknown button.', ephemeral: true });
  }
}

// ============================================
// MODAL HANDLER
// ============================================
async function handleModal(interaction) {
  if (interaction.customId === 'ticket_modal') {
    await createTicket(interaction);
  }
}

// ============================================
// SELECT MENU HANDLER
// ============================================
async function handleSelectMenu(interaction) {
  // Reserved for future use
  await interaction.reply({ content: 'Feature coming soon!', ephemeral: true });
}

// ============================================
// COMMAND: /panel
// ============================================
async function handlePanel(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ This command is restricted to the bot owner.', ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle('🏦 Schior\'s Auto Middleman Service')
    .setDescription(
      'Welcome to the secure automated escrow service!\n\n' +
      '**How it works:**\n' +
      '1. Click "Create Trade" below\n' +
      '2. Fill in trade details\n' +
      '3. Send LTC to the provided address\n' +
      '4. Once confirmed, sender can release or refund\n\n' +
      '**Features:**\n' +
      '• Secure escrow holding\n' +
      '• Automatic deposit detection\n' +
      '• Blockchain confirmation tracking\n' +
      '• Fee: 0.001 LTC per transaction\n\n' +
      '⚠️ **Only send LTC to the provided address!**'
    )
    .setColor(0x3498db)
    .setTimestamp()
    .setFooter({ text: 'Secure • Automated • Index 0 Only' });

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('create_ticket')
        .setLabel('🎫 Create Trade')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🤝')
    );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ============================================
// MODAL: Create Trade
// ============================================
async function showTicketModal(interaction) {
  // Check if user already has active trade
  for (const [id, ticket] of activeTickets) {
    if (ticket.sender === interaction.user.id && ticket.status === 'waiting_deposit') {
      return interaction.reply({ 
        content: '❌ You already have an active trade waiting for deposit. Complete or cancel it first.', 
        ephemeral: true 
      });
    }
  }

  const modal = new ModalBuilder()
    .setCustomId('ticket_modal')
    .setTitle('🎫 Create New Trade');

  const givingInput = new TextInputBuilder()
    .setCustomId('giving')
    .setLabel('What are YOU giving?')
    .setPlaceholder('e.g. 100 LTC, Rare NFT, Gaming Account...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const receivingInput = new TextInputBuilder()
    .setCustomId('receiving')
    .setLabel('What is he/she giving?')
    .setPlaceholder('e.g. PayPal $500, Bitcoin, Steam Gift Card...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const otherPartyInput = new TextInputBuilder()
    .setCustomId('other_party')
    .setLabel('Other party Discord ID or @mention')
    .setPlaceholder('@username or 1234567890123456789')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const ltcAmountInput = new TextInputBuilder()
    .setCustomId('ltc_amount')
    .setLabel('LTC Amount to escrow')
    .setPlaceholder('0.5')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(givingInput),
    new ActionRowBuilder().addComponents(receivingInput),
    new ActionRowBuilder().addComponents(otherPartyInput),
    new ActionRowBuilder().addComponents(ltcAmountInput)
  );

  await interaction.showModal(modal);
}

// ============================================
// CREATE TICKET
// ============================================
async function createTicket(interaction) {
  const giving = interaction.fields.getTextInputValue('giving');
  const receiving = interaction.fields.getTextInputValue('receiving');
  const otherPartyRaw = interaction.fields.getTextInputValue('other_party');
  const ltcAmount = parseFloat(interaction.fields.getTextInputValue('ltc_amount'));

  // Validation
  if (isNaN(ltcAmount) || ltcAmount <= 0) {
    return interaction.reply({ content: '❌ Invalid LTC amount. Please enter a positive number.', ephemeral: true });
  }

  if (ltcAmount < 0.001) {
    return interaction.reply({ content: '❌ Minimum amount is 0.001 LTC.', ephemeral: true });
  }

  // Parse other party ID
  let otherPartyId = otherPartyRaw.replace(/[<@!>]/g, '');
  
  if (otherPartyId === interaction.user.id) {
    return interaction.reply({ content: '❌ You cannot trade with yourself!', ephemeral: true });
  }

  if (otherPartyId === client.user.id) {
    return interaction.reply({ content: '❌ You cannot trade with the bot!', ephemeral: true });
  }

  try {
    const otherMember = await interaction.guild.members.fetch(otherPartyId).catch(() => null);
    
    if (!otherMember) {
      return interaction.reply({ 
        content: '❌ Could not find the other user. Make sure they are in this server.', 
        ephemeral: true 
      });
    }

    if (otherMember.user.bot) {
      return interaction.reply({ content: '❌ You cannot trade with bots!', ephemeral: true });
    }

    // INDEX 0 ADDRESS - ONLY ONE ADDRESS EVER USED
    const escrowAddress = getAddress();
    const ticketId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    const ticketData = {
      id: ticketId,
      sender: interaction.user.id,
      receiver: otherPartyId,
      giving: giving,
      receiving: receiving,
      ltcAmount: ltcAmount,
      escrowAddress: escrowAddress,
      status: 'waiting_deposit',
      channelId: null,
      messageId: null,
      depositTx: null,
      createdAt: new Date().toISOString()
    };
    
    activeTickets.set(ticketId, ticketData);

    // Create ticket channel
    const channelOptions = {
      name: `trade-${ticketId.substr(-6)}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: interaction.guild.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel, 
            PermissionFlagsBits.SendMessages, 
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: otherPartyId,
          allow: [
            PermissionFlagsBits.ViewChannel, 
            PermissionFlagsBits.SendMessages, 
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel, 
            PermissionFlagsBits.SendMessages, 
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages
          ]
        }
      ]
    };

    if (TICKET_CATEGORY) {
      channelOptions.parent = TICKET_CATEGORY;
    }

    const channel = await interaction.guild.channels.create(channelOptions);
    activeTickets.get(ticketId).channelId = channel.id;

    // Save to database
    saveTicket(ticketData);

    // Get price info
    const ltcPrice = await getLtcPriceUSD();
    const usdValue = (ltcAmount * ltcPrice).toFixed(2);
    const totalWithFee = ltcAmount + FEE_LTC;
    const totalUsd = (totalWithFee * ltcPrice).toFixed(2);

    // Create embed
    const embed = new EmbedBuilder()
      .setTitle(`🤝 Trade #${ticketId}`)
      .setDescription(
        `**Status:** ⏳ Waiting for deposit\n\n` +
        `**Trade Details:**\n` +
        `• **${interaction.user.username}** gives: **${giving}**\n` +
        `• **${otherMember.user.username}** gives: **${receiving}**`
      )
      .addFields(
        { name: '💰 Required Deposit', value: `${ltcAmount} LTC ($${usdValue})`, inline: true },
        { name: '⚡ Network Fee', value: `${FEE_LTC} LTC`, inline: true },
        { name: '💵 Total to Send', value: `${totalWithFee.toFixed(6)} LTC ($${totalUsd})`, inline: true },
        { name: '📍 Deposit Address (INDEX 0)', value: `\`${escrowAddress}\`` },
        { name: '🔑 Sender', value: `<@${interaction.user.id}>`, inline: true },
        { name: '👤 Receiver', value: `<@${otherPartyId}>`, inline: true },
        { name: '⏱️ Expires', value: `<t:${Math.floor(Date.now() / 1000) + 1800}:R>`, inline: true }
      )
      .setColor(0xf39c12)
      .setTimestamp()
      .setFooter({ text: 'Send exact amount including fee • Using Index 0 Only' });

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_${ticketId}`)
          .setLabel('❌ Cancel Trade')
          .setStyle(ButtonStyle.Danger)
      );

    const msg = await channel.send({ 
      content: `<@${interaction.user.id}> <@${otherPartyId}> **New trade created!**`,
      embeds: [embed], 
      components: [row] 
    });
    
    activeTickets.get(ticketId).messageId = msg.id;
    updateTicketStatus(ticketId, 'waiting_deposit', { messageId: msg.id });

    // Start monitoring INDEX 0 for deposit
    monitorDeposit(ticketId, channel, ltcAmount);

    // Confirmation message
    const confirmEmbed = new EmbedBuilder()
      .setTitle('✅ Trade Created Successfully')
      .setDescription(
        `Your trade has been created!\n\n` +
        `**Channel:** <#${channel.id}>\n` +
        `**Amount to send:** ${totalWithFee.toFixed(6)} LTC\n` +
        `**Address:** \`${escrowAddress}\`\n\n` +
        `⚠️ **Important:** Send the exact amount including the ${FEE_LTC} LTC fee!`
      )
      .setColor(0x2ecc71);

    await interaction.reply({ embeds: [confirmEmbed], ephemeral: true });

  } catch (error) {
    console.error('❌ Create ticket error:', error);
    await interaction.reply({ 
      content: `❌ Error creating trade: ${error.message}`, 
      ephemeral: true 
    });
  }
}

// ============================================
// MONITOR DEPOSIT (INDEX 0 ONLY)
// ============================================
async function monitorDeposit(ticketId, channel, expectedAmount) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket) return;

  console.log(`[Monitor] Starting deposit monitor for ticket ${ticketId} on INDEX 0`);
  console.log(`[Monitor] Expected: ${expectedAmount} LTC, Address: ${ticket.escrowAddress}`);

  let checkCount = 0;
  let lastBalance = 0;
  const startTime = Date.now();

  const checkInterval = setInterval(async () => {
    try {
      checkCount++;
      
      // Check if ticket still exists
      if (!activeTickets.has(ticketId)) {
        console.log(`[Ticket ${ticketId}] Ticket no longer exists, stopping monitor`);
        clearInterval(checkInterval);
        depositMonitors.delete(ticketId);
        return;
      }

      // Check if channel still exists
      const currentChannel = client.channels.cache.get(ticket.channelId);
      if (!currentChannel) {
        console.log(`[Ticket ${ticketId}] Channel deleted, stopping monitor`);
        clearInterval(checkInterval);
        depositMonitors.delete(ticketId);
        activeTickets.delete(ticketId);
        return;
      }

      // INDEX 0 BALANCE CHECK ONLY - NO LOOPS, NO HD SCANNING
      const balance = await getBalance();
      
      const confirmedLTC = balance.confirmed;
      const unconfirmedLTC = balance.unconfirmed;
      const totalLTC = balance.total;

      // Log every 10 checks to avoid spam
      if (checkCount % 10 === 0 || confirmedLTC !== lastBalance) {
        console.log(`[Ticket ${ticketId}] Check #${checkCount} | Index 0 - Confirmed: ${confirmedLTC}, Unconfirmed: ${unconfirmedLTC}`);
        lastBalance = confirmedLTC;
      }

      // Check for timeout
      if (Date.now() - startTime > DEPOSIT_TIMEOUT) {
        clearInterval(checkInterval);
        depositMonitors.delete(ticketId);
        
        const timeoutEmbed = new EmbedBuilder()
          .setTitle('⏰ Trade Expired')
          .setDescription('This trade has expired due to inactivity. No deposit was detected within 30 minutes.')
          .setColor(0x95a5a6);
        
        await channel.send({ embeds: [timeoutEmbed] });
        updateTicketStatus(ticketId, 'expired');
        
        setTimeout(() => channel.delete().catch(() => {}), 60000);
        return;
      }

      // Check if we have any funds
      if (unconfirmedLTC > 0 || confirmedLTC > 0) {
        
        // Check if amount is sufficient (within 15% tolerance for fees)
        const detectedAmount = confirmedLTC > 0 ? confirmedLTC : unconfirmedLTC;
        
        if (detectedAmount < expectedAmount * 0.85) {
          console.log(`[Ticket ${ticketId}] Amount too low: ${detectedAmount} LTC, expected: ~${expectedAmount} LTC`);
          
          // Send warning if amount is significantly low
          if (detectedAmount < expectedAmount * 0.5 && checkCount % 30 === 0) {
            const lowEmbed = new EmbedBuilder()
              .setTitle('⚠️ Low Deposit Detected')
              .setDescription(
                `Detected: ${detectedAmount.toFixed(8)} LTC\n` +
                `Expected: ~${expectedAmount} LTC\n\n` +
                `Please send the remaining amount or contact the sender.`
              )
              .setColor(0xe67e22);
            await channel.send({ embeds: [lowEmbed] });
          }
        } else {
          // Sufficient amount detected
          clearInterval(checkInterval);
          depositMonitors.delete(ticketId);
          
          const ltcPrice = await getLtcPriceUSD();
          
          if (unconfirmedLTC > 0 && confirmedLTC < expectedAmount * 0.85) {
            // Unconfirmed deposit detected
            const usdValue = (unconfirmedLTC * ltcPrice).toFixed(2);
            
            const embed = new EmbedBuilder()
              .setTitle(`🤝 Trade #${ticketId}`)
              .setDescription(
                `**Status:** ⏳ Deposit detected (unconfirmed)\n\n` +
                `Transaction found on blockchain, waiting for confirmation...`
              )
              .addFields(
                { name: '💰 Unconfirmed Amount', value: `${unconfirmedLTC.toFixed(8)} LTC ($${usdValue})`, inline: true },
                { name: '⏱️ Expected', value: `${expectedAmount} LTC`, inline: true },
                { name: '📍 Deposit Address', value: `\`${ticket.escrowAddress}\`` },
                { name: '⏳ Note', value: 'Funds are safe but need blockchain confirmation (usually 2-6 minutes)' }
              )
              .setColor(0xe67e22)
              .setTimestamp();

            await channel.send({ embeds: [embed] });
            
            // Continue monitoring for confirmation
            monitorConfirmation(ticketId, channel, expectedAmount);
          }
          else if (confirmedLTC >= expectedAmount * 0.85) {
            // Confirmed deposit
            await handleConfirmedDeposit(ticketId, channel, confirmedLTC, ltcPrice);
          }
        }
      }
      
    } catch (error) {
      console.error(`[Ticket ${ticketId}] Monitor error:`, error.message);
    }
  }, 10000); // Check every 10 seconds

  depositMonitors.set(ticketId, checkInterval);
  ticket.monitorInterval = checkInterval;
}

// ============================================
// MONITOR CONFIRMATION (INDEX 0 ONLY)
// ============================================
async function monitorConfirmation(ticketId, channel, expectedAmount) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket) return;

  console.log(`[Monitor] Starting confirmation monitor for ticket ${ticketId}`);

  let checkCount = 0;
  const startTime = Date.now();

  const confirmInterval = setInterval(async () => {
    try {
      checkCount++;
      
      // Check if ticket still exists
      if (!activeTickets.has(ticketId)) {
        clearInterval(confirmInterval);
        return;
      }

      // INDEX 0 ONLY - NO OTHER INDICES
      const balance = await getBalance();
      const confirmedLTC = balance.confirmed;

      if (confirmedLTC >= expectedAmount * 0.85) {
        clearInterval(confirmInterval);
        if (ticket.confirmInterval) delete ticket.confirmInterval;
        
        const ltcPrice = await getLtcPriceUSD();
        await handleConfirmedDeposit(ticketId, channel, confirmedLTC, ltcPrice);
        return;
      }
      
      // Check for timeout
      if (Date.now() - startTime > CONFIRMATION_TIMEOUT) {
        clearInterval(confirmInterval);
        if (ticket.confirmInterval) delete ticket.confirmInterval;
        
        const timeoutEmbed = new EmbedBuilder()
          .setTitle('⏰ Confirmation Timeout')
          .setDescription(
            'Deposit is taking longer than expected to confirm.\n' +
            'This can happen during network congestion.\n\n' +
            'The funds are safe. Contact owner if issues persist.'
          )
          .setColor(0x95a5a6);
        
        await channel.send({ embeds: [timeoutEmbed] });
      }
      
    } catch (error) {
      console.error(`[Ticket ${ticketId}] Confirmation error:`, error.message);
    }
  }, 15000); // Check every 15 seconds
  
  ticket.confirmInterval = confirmInterval;
}

// ============================================
// HANDLE CONFIRMED DEPOSIT
// ============================================
async function handleConfirmedDeposit(ticketId, channel, amount, ltcPrice) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket || ticket.status !== 'waiting_deposit') {
    console.log(`[Ticket ${ticketId}] Already handled or invalid status: ${ticket?.status}`);
    return;
  }

  console.log(`[Ticket ${ticketId}] Deposit confirmed: ${amount} LTC`);

  ticket.status = 'funded';
  const usdValue = (amount * ltcPrice).toFixed(2);

  // Update database
  updateTicketStatus(ticketId, 'funded', { 
    depositAmount: amount,
    completedAt: null
  });

  const embed = new EmbedBuilder()
    .setTitle(`🤝 Trade #${ticketId}`)
    .setDescription(
      `**Status:** ✅ **FUNDED & CONFIRMED**\n\n` +
      `The deposit has been confirmed on the blockchain and is now held in escrow!`
    )
    .addFields(
      { name: '💰 Confirmed Amount', value: `${amount.toFixed(8)} LTC ($${usdValue})`, inline: true },
      { name: '🔒 Held in Escrow', value: 'Index 0 Wallet', inline: true },
      { name: '🔑 Sender', value: `<@${ticket.sender}>`, inline: true },
      { name: '👤 Receiver', value: `<@${ticket.receiver}>`, inline: true },
      { name: '📋 Trade Details', value: `**Sender gives:** ${ticket.giving}\n**Receiver gives:** ${ticket.receiving}` }
    )
    .setColor(0x2ecc71)
    .setTimestamp()
    .setFooter({ text: 'Sender can now release or request refund' });

  // Buttons for sender only
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`sender_release_${ticketId}`)
        .setLabel('✅ Release to Receiver')
        .setStyle(ButtonStyle.Success)
        .setEmoji('💸'),
      new ButtonBuilder()
        .setCustomId(`sender_refund_${ticketId}`)
        .setLabel('🔄 Refund to Me')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('↩️')
    );

  await channel.send({
    content: `<@${ticket.sender}> **Your deposit is confirmed!** The funds are now held in escrow. Choose an action when ready:`,
    embeds: [embed],
    components: [row]
  });

  // Notify receiver
  await channel.send({
    content: `<@${ticket.receiver}> **The sender has deposited ${amount.toFixed(6)} LTC!** Waiting for them to release after you complete your part of the trade.`
  });
}

// ============================================
// HANDLE SENDER RELEASE
// ============================================
async function handleSenderRelease(interaction) {
  const ticketId = interaction.customId.replace('sender_release_', '');
  const ticket = activeTickets.get(ticketId);
  
  if (!ticket) {
    return interaction.reply({ content: '❌ Trade not found or already completed.', ephemeral: true });
  }
  
  if (interaction.user.id !== ticket.sender) {
    return interaction.reply({ content: '❌ Only the sender can release the funds.', ephemeral: true });
  }

  if (ticket.status !== 'funded') {
    return interaction.reply({ content: '❌ No funds in escrow to release.', ephemeral: true });
  }

  await interaction.deferReply();

  try {
    // Ask for receiver address
    const filter = m => m.author.id === ticket.receiver;
    
    const askEmbed = new EmbedBuilder()
      .setTitle('💸 Release Funds')
      .setDescription(`<@${ticket.receiver}> **Please provide your LTC address to receive ${ticket.ltcAmount} LTC**`)
      .setColor(0x3498db);

    await interaction.followUp({ 
      content: `<@${ticket.receiver}>`,
      embeds: [askEmbed]
    });

    const collector = interaction.channel.createMessageCollector({ 
      filter, 
      max: 1, 
      time: 600000 // 10 minutes
    });

    collector.on('collect', async (msg) => {
      const receiverAddress = msg.content.trim();
      
      // Validate address format
      if (!receiverAddress || receiverAddress.length < 26) {
        return interaction.channel.send('❌ Invalid LTC address format. Please use `/release` command or contact owner.');
      }

      if (!receiverAddress.startsWith('L') && !receiverAddress.startsWith('ltc1') && !receiverAddress.startsWith('M')) {
        return interaction.channel.send('❌ Invalid LTC address. Must start with L, ltc1, or M.');
      }

      try {
        const processingEmbed = new EmbedBuilder()
          .setTitle('⏳ Processing Release')
          .setDescription('Sending funds to receiver... This may take a moment.')
          .setColor(0xf39c12);
        
        await interaction.channel.send({ embeds: [processingEmbed] });
        
        // Send from INDEX 0
        const result = await sendAllL interaction.reply({ 
        content: '❌ You already have an active trade waiting for deposit. Complete or cancel it first.', 
        ephemeral: true 
      });
    }
  }

  const modal = new ModalBuilder()
    .setCustomId('ticket_modal')
    .setTitle('🎫 Create New Trade');

  const givingInput = new TextInputBuilder()
    .setCustomId('giving')
    .setLabel('What are YOU giving?')
    .setPlaceholder('e.g. 100 LTC, Rare NFT, Gaming Account...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const receivingInput = new TextInputBuilder()
    .setCustomId('receiving')
    .setLabel('What is he/she giving?')
    .setPlaceholder('e.g. PayPal $500, Bitcoin, Steam Gift Card...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const otherPartyInput = new TextInputBuilder()
    .setCustomId('other_party')
    .setLabel('Other party Discord ID or @mention')
    .setPlaceholder('@username or 1234567890123456789')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const ltcAmountInput = new TextInputBuilder()
    .setCustomId('ltc_amount')
    .setLabel('LTC Amount to escrow')
    .setPlaceholder('0.5')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(givingInput),
    new ActionRowBuilder().addComponents(receivingInput),
    new ActionRowBuilder().addComponents(otherPartyInput),
    new ActionRowBuilder().addComponents(ltcAmountInput)
  );

  await interaction.showModal(modal);
}

// ============================================
// CREATE TICKET
// ============================================
async function createTicket(interaction) {
  const giving = interaction.fields.getTextInputValue('giving');
  const receiving = interaction.fields.getTextInputValue('receiving');
  const otherPartyRaw = interaction.fields.getTextInputValue('other_party');
  const ltcAmount = parseFloat(interaction.fields.getTextInputValue('ltc_amount'));

  // Validation
  if (isNaN(ltcAmount) || ltcAmount <= 0) {
    return interaction.reply({ content: '❌ Invalid LTC amount. Please enter a positive number.', ephemeral: true });
  }

  if (ltcAmount < 0.001) {
    return interaction.reply({ content: '❌ Minimum amount is 0.001 LTC.', ephemeral: true });
  }

  // Parse other party ID
  let otherPartyId = otherPartyRaw.replace(/[<@!>]/g, '');
  
  if (otherPartyId === interaction.user.id) {
    return interaction.reply({ content: '❌ You cannot trade with yourself!', ephemeral: true });
  }

  if (otherPartyId === client.user.id) {
    return interaction.reply({ content: '❌ You cannot trade with the bot!', ephemeral: true });
  }

  try {
    const otherMember = await interaction.guild.members.fetch(otherPartyId).catch(() => null);
    
    if (!otherMember) {
      return interaction.reply({ 
        content: '❌ Could not find the other user. Make sure they are in this server.', 
        ephemeral: true 
      });
    }

    if (otherMember.user.bot) {
      return interaction.reply({ content: '❌ You cannot trade with bots!', ephemeral: true });
    }

    // INDEX 0 ADDRESS - ONLY ONE ADDRESS EVER USED
    const escrowAddress = getAddress();
    const ticketId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    const ticketData = {
      id: ticketId,
      sender: interaction.user.id,
      receiver: otherPartyId,
      giving: giving,
      receiving: receiving,
      ltcAmount: ltcAmount,
      escrowAddress: escrowAddress,
      status: 'waiting_deposit',
      channelId: null,
      messageId: null,
      depositTx: null,
      createdAt: new Date().toISOString()
    };
    
    activeTickets.set(ticketId, ticketData);

    // Create ticket channel
    const channelOptions = {
      name: `trade-${ticketId.substr(-6)}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: interaction.guild.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel, 
            PermissionFlagsBits.SendMessages, 
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: otherPartyId,
          allow: [
            PermissionFlagsBits.ViewChannel, 
            PermissionFlagsBits.SendMessages, 
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel, 
            PermissionFlagsBits.SendMessages, 
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages
          ]
        }
      ]
    };

    if (TICKET_CATEGORY) {
      channelOptions.parent = TICKET_CATEGORY;
    }

    const channel = await interaction.guild.channels.create(channelOptions);
    activeTickets.get(ticketId).channelId = channel.id;

    // Save to database
    saveTicket(ticketData);

    // Get price info
    const ltcPrice = await getLtcPriceUSD();
    const usdValue = (ltcAmount * ltcPrice).toFixed(2);
    const totalWithFee = ltcAmount + FEE_LTC;
    const totalUsd = (totalWithFee * ltcPrice).toFixed(2);

    // Create embed
    const embed = new EmbedBuilder()
      .setTitle(`🤝 Trade #${ticketId}`)
      .setDescription(
        `**Status:** ⏳ Waiting for deposit\n\n` +
        `**Trade Details:**\n` +
        `• **${interaction.user.username}** gives: **${giving}**\n` +
        `• **${otherMember.user.username}** gives: **${receiving}**`
      )
      .addFields(
        { name: '💰 Required Deposit', value: `${ltcAmount} LTC ($${usdValue})`, inline: true },
        { name: '⚡ Network Fee', value: `${FEE_LTC} LTC`, inline: true },
        { name: '💵 Total to Send', value: `${totalWithFee.toFixed(6)} LTC ($${totalUsd})`, inline: true },
        { name: '📍 Deposit Address (INDEX 0)', value: `\`${escrowAddress}\`` },
        { name: '🔑 Sender', value: `<@${interaction.user.id}>`, inline: true },
        { name: '👤 Receiver', value: `<@${otherPartyId}>`, inline: true },
        { name: '⏱️ Expires', value: `<t:${Math.floor(Date.now() / 1000) + 1800}:R>`, inline: true }
      )
      .setColor(0xf39c12)
      .setTimestamp()
      .setFooter({ text: 'Send exact amount including fee • Using Index 0 Only' });

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_${ticketId}`)
          .setLabel('❌ Cancel Trade')
          .setStyle(ButtonStyle.Danger)
      );

    const msg = await channel.send({ 
      content: `<@${interaction.user.id}> <@${otherPartyId}> **New trade created!**`,
      embeds: [embed], 
      components: [row] 
    });
    
    activeTickets.get(ticketId).messageId = msg.id;
    updateTicketStatus(ticketId, 'waiting_deposit', { messageId: msg.id });

    // Start monitoring INDEX 0 for deposit
    monitorDeposit(ticketId, channel, ltcAmount);

    // Confirmation message
    const confirmEmbed = new EmbedBuilder()
      .setTitle('✅ Trade Created Successfully')
      .setDescription(
        `Your trade has been created!\n\n` +
        `**Channel:** <#${channel.id}>\n` +
        `**Amount to send:** ${totalWithFee.toFixed(6)} LTC\n` +
        `**Address:** \`${escrowAddress}\`\n\n` +
        `⚠️ **Important:** Send the exact amount including the ${FEE_LTC} LTC fee!`
      )
      .setColor(0x2ecc71);

    await interaction.reply({ embeds: [confirmEmbed], ephemeral: true });

  } catch (error) {
    console.error('❌ Create ticket error:', error);
    await interaction.reply({ 
      content: `❌ Error creating trade: ${error.message}`, 
      ephemeral: true 
    });
  }
}

// ============================================
// MONITOR DEPOSIT (INDEX 0 ONLY)
// ============================================
async function monitorDeposit(ticketId, channel, expectedAmount) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket) return;

  console.log(`[Monitor] Starting deposit monitor for ticket ${ticketId} on INDEX 0`);
  console.log(`[Monitor] Expected: ${expectedAmount} LTC, Address: ${ticket.escrowAddress}`);

  let checkCount = 0;
  let lastBalance = 0;
  const startTime = Date.now();

  const checkInterval = setInterval(async () => {
    try {
      checkCount++;
      
      // Check if ticket still exists
      if (!activeTickets.has(ticketId)) {
        console.log(`[Ticket ${ticketId}] Ticket no longer exists, stopping monitor`);
        clearInterval(checkInterval);
        depositMonitors.delete(ticketId);
        return;
      }

      // Check if channel still exists
      const currentChannel = client.channels.cache.get(ticket.channelId);
      if (!currentChannel) {
        console.log(`[Ticket ${ticketId}] Channel deleted, stopping monitor`);
        clearInterval(checkInterval);
        depositMonitors.delete(ticketId);
        activeTickets.delete(ticketId);
        return;
      }

      // INDEX 0 BALANCE CHECK ONLY - NO LOOPS, NO HD SCANNING
      const balance = await getBalance();
      
      const confirmedLTC = balance.confirmed;
      const unconfirmedLTC = balance.unconfirmed;
      const totalLTC = balance.total;

      // Log every 10 checks to avoid spam
      if (checkCount % 10 === 0 || confirmedLTC !== lastBalance) {
        console.log(`[Ticket ${ticketId}] Check #${checkCount} | Index 0 - Confirmed: ${confirmedLTC}, Unconfirmed: ${unconfirmedLTC}`);
        lastBalance = confirmedLTC;
      }

      // Check for timeout
      if (Date.now() - startTime > DEPOSIT_TIMEOUT) {
        clearInterval(checkInterval);
        depositMonitors.delete(ticketId);
        
        const timeoutEmbed = new EmbedBuilder()
          .setTitle('⏰ Trade Expired')
          .setDescription('This trade has expired due to inactivity. No deposit was detected within 30 minutes.')
          .setColor(0x95a5a6);
        
        await channel.send({ embeds: [timeoutEmbed] });
        updateTicketStatus(ticketId, 'expired');
        
        setTimeout(() => channel.delete().catch(() => {}), 60000);
        return;
      }

      // Check if we have any funds
      if (unconfirmedLTC > 0 || confirmedLTC > 0) {
        
        // Check if amount is sufficient (within 15% tolerance for fees)
        const detectedAmount = confirmedLTC > 0 ? confirmedLTC : unconfirmedLTC;
        
        if (detectedAmount < expectedAmount * 0.85) {
          console.log(`[Ticket ${ticketId}] Amount too low: ${detectedAmount} LTC, expected: ~${expectedAmount} LTC`);
          
          // Send warning if amount is significantly low
          if (detectedAmount < expectedAmount * 0.5 && checkCount % 30 === 0) {
            const lowEmbed = new EmbedBuilder()
              .setTitle('⚠️ Low Deposit Detected')
              .setDescription(
                `Detected: ${detectedAmount.toFixed(8)} LTC\n` +
                `Expected: ~${expectedAmount} LTC\n\n` +
                `Please send the remaining amount or contact the sender.`
              )
              .setColor(0xe67e22);
            await channel.send({ embeds: [lowEmbed] });
          }
        } else {
          // Sufficient amount detected
          clearInterval(checkInterval);
          depositMonitors.delete(ticketId);
          
          const ltcPrice = await getLtcPriceUSD();
          
          if (unconfirmedLTC > 0 && confirmedLTC < expectedAmount * 0.85) {
            // Unconfirmed deposit detected
            const usdValue = (unconfirmedLTC * ltcPrice).toFixed(2);
            
            const embed = new EmbedBuilder()
              .setTitle(`🤝 Trade #${ticketId}`)
              .setDescription(
                `**Status:** ⏳ Deposit detected (unconfirmed)\n\n` +
                `Transaction found on blockchain, waiting for confirmation...`
              )
              .addFields(
                { name: '💰 Unconfirmed Amount', value: `${unconfirmedLTC.toFixed(8)} LTC ($${usdValue})`, inline: true },
                { name: '⏱️ Expected', value: `${expectedAmount} LTC`, inline: true },
                { name: '📍 Deposit Address', value: `\`${ticket.escrowAddress}\`` },
                { name: '⏳ Note', value: 'Funds are safe but need blockchain confirmation (usually 2-6 minutes)' }
              )
              .setColor(0xe67e22)
              .setTimestamp();

            await channel.send({ embeds: [embed] });
            
            // Continue monitoring for confirmation
            monitorConfirmation(ticketId, channel, expectedAmount);
          }
          else if (confirmedLTC >= expectedAmount * 0.85) {
            // Confirmed deposit
            await handleConfirmedDeposit(ticketId, channel, confirmedLTC, ltcPrice);
          }
        }
      }
      
    } catch (error) {
      console.error(`[Ticket ${ticketId}] Monitor error:`, error.message);
    }
  }, 10000); // Check every 10 seconds

  depositMonitors.set(ticketId, checkInterval);
  ticket.monitorInterval = checkInterval;
}

// ============================================
// MONITOR CONFIRMATION (INDEX 0 ONLY)
// ============================================
async function monitorConfirmation(ticketId, channel, expectedAmount) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket) return;

  console.log(`[Monitor] Starting confirmation monitor for ticket ${ticketId}`);

  let checkCount = 0;
  const startTime = Date.now();

  const confirmInterval = setInterval(async () => {
    try {
      checkCount++;
      
      // Check if ticket still exists
      if (!activeTickets.has(ticketId)) {
        clearInterval(confirmInterval);
        return;
      }

      // INDEX 0 ONLY - NO OTHER INDICES
      const balance = await getBalance();
      const confirmedLTC = balance.confirmed;

      if (confirmedLTC >= expectedAmount * 0.85) {
        clearInterval(confirmInterval);
        if (ticket.confirmInterval) delete ticket.confirmInterval;
        
        const ltcPrice = await getLtcPriceUSD();
        await handleConfirmedDeposit(ticketId, channel, confirmedLTC, ltcPrice);
        return;
      }
      
      // Check for timeout
      if (Date.now() - startTime > CONFIRMATION_TIMEOUT) {
        clearInterval(confirmInterval);
        if (ticket.confirmInterval) delete ticket.confirmInterval;
        
        const timeoutEmbed = new EmbedBuilder()
          .setTitle('⏰ Confirmation Timeout')
          .setDescription(
            'Deposit is taking longer than expected to confirm.\n' +
            'This can happen during network congestion.\n\n' +
            'The funds are safe. Contact owner if issues persist.'
          )
          .setColor(0x95a5a6);
        
        await channel.send({ embeds: [timeoutEmbed] });
      }
      
    } catch (error) {
      console.error(`[Ticket ${ticketId}] Confirmation error:`, error.message);
    }
  }, 15000); // Check every 15 seconds
  
  ticket.confirmInterval = confirmInterval;
}

// ============================================
// HANDLE CONFIRMED DEPOSIT
// ============================================
async function handleConfirmedDeposit(ticketId, channel, amount, ltcPrice) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket || ticket.status !== 'waiting_deposit') {
    console.log(`[Ticket ${ticketId}] Already handled or invalid status: ${ticket?.status}`);
    return;
  }

  console.log(`[Ticket ${ticketId}] Deposit confirmed: ${amount} LTC`);

  ticket.status = 'funded';
  const usdValue = (amount * ltcPrice).toFixed(2);

  // Update database
  updateTicketStatus(ticketId, 'funded', { 
    depositAmount: amount,
    completedAt: null
  });

  const embed = new EmbedBuilder()
    .setTitle(`🤝 Trade #${ticketId}`)
    .setDescription(
      `**Status:** ✅ **FUNDED & CONFIRMED**\n\n` +
      `The deposit has been confirmed on the blockchain and is now held in escrow!`
    )
    .addFields(
      { name: '💰 Confirmed Amount', value: `${amount.toFixed(8)} LTC ($${usdValue})`, inline: true },
      { name: '🔒 Held in Escrow', value: 'Index 0 Wallet', inline: true },
      { name: '🔑 Sender', value: `<@${ticket.sender}>`, inline: true },
      { name: '👤 Receiver', value: `<@${ticket.receiver}>`, inline: true },
      { name: '📋 Trade Details', value: `**Sender gives:** ${ticket.giving}\n**Receiver gives:** ${ticket.receiving}` }
    )
    .setColor(0x2ecc71)
    .setTimestamp()
    .setFooter({ text: 'Sender can now release or request refund' });

  // Buttons for sender only
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`sender_release_${ticketId}`)
        .setLabel('✅ Release to Receiver')
        .setStyle(ButtonStyle.Success)
        .setEmoji('💸'),
      new ButtonBuilder()
        .setCustomId(`sender_refund_${ticketId}`)
        .setLabel('🔄 Refund to Me')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('↩️')
    );

  await channel.send({
    content: `<@${ticket.sender}> **Your deposit is confirmed!** The funds are now held in escrow. Choose an action when ready:`,
    embeds: [embed],
    components: [row]
  });

  // Notify receiver
  await channel.send({
    content: `<@${ticket.receiver}> **The sender has deposited ${amount.toFixed(6)} LTC!** Waiting for them to release after you complete your part of the trade.`
  });
}

// ============================================
// HANDLE SENDER RELEASE
// ============================================
async function handleSenderRelease(interaction) {
  const ticketId = interaction.customId.replace('sender_release_', '');
  const ticket = activeTickets.get(ticketId);
  
  if (!ticket) {
    return interaction.reply({ content: '❌ Trade not found or already completed.', ephemeral: true });
  }
  
  if (interaction.user.id !== ticket.sender) {
    return interaction.reply({ content: '❌ Only the sender can release the funds.', ephemeral: true });
  }

  if (ticket.status !== 'funded') {
    return interaction.reply({ content: '❌ No funds in escrow to release.', ephemeral: true });
  }

  await interaction.deferReply();

  try {
    // Ask for receiver address
    const filter = m => m.author.id === ticket.receiver;
    
    const askEmbed = new EmbedBuilder()
      .setTitle('💸 Release Funds')
      .setDescription(`<@${ticket.receiver}> **Please provide your LTC address to receive ${ticket.ltcAmount} LTC**`)
      .setColor(0x3498db);

    await interaction.followUp({ 
      content: `<@${ticket.receiver}>`,
      embeds: [askEmbed]
    });

    const collector = interaction.channel.createMessageCollector({ 
      filter, 
      max: 1, 
      time: 600000 // 10 minutes
    });

    collector.on('collect', async (msg) => {
      const receiverAddress = msg.content.trim();
      
      // Validate address format
      if (!receiverAddress || receiverAddress.length < 26) {
        return interaction.channel.send('❌ Invalid LTC address format. Please use `/release` command or contact owner.');
      }

      if (!receiverAddress.startsWith('L') && !receiverAddress.startsWith('ltc1') && !receiverAddress.startsWith('M')) {
        return interaction.channel.send('❌ Invalid LTC address. Must start with L, ltc1, or M.');
      }

      try {
        const processingEmbed = new EmbedBuilder()
          .setTitle('⏳ Processing Release')
          .setDescription('Sending funds to receiver... This may take a moment.')
          .setColor(0xf39c12);
        
        await interaction.channel.send({ embeds: [processingEmbed] });
        
        // Send from INDEX 0
        const result = await sendAllLTC(receiverAddress, FEE_LTC);
        
        const ltcPrice = await getLtcPriceUSD();
        const usdValue = (result.amount * ltcPrice).toFixed(2);
        
        const successEmbed = new EmbedBuilder()
          .setTitle('✅ Trade Complete - Funds Released')
          .setDescription(`The escrow has been successfully released to the receiver!`)
          .addFields(
            { name: '💰 Amount Released', value: `${result.amount.toFixed(8)} LTC ($${usdValue})`, inline: true },
            { name: '⚡ Fee Paid', value: `${FEE_LTC} LTC`, inline: true },
            { name: '📤 Receiver Address', value: `\`${receiverAddress}\``, inline: false },
            { name: '🔗 Transaction', value: `[View on BlockCypher](https://live.blockcypher.com/ltc/tx/${result.txHash}/)` },
            { name: '📍 Sent From', value: 'Index 0 Wallet', inline: true },
            { name: '✅ Status', value: 'Completed', inline: true }
          )
          .setColor(0x2ecc71)
          .setTimestamp();

        await interaction.channel.send({ embeds: [successEmbed] });
        
        ticket.status = 'completed';
        
        // Update database
        updateTicketStatus(ticketId, 'completed', { 
          txHash: result.txHash,
          completedAt: new Date().toISOString()
        });
        
        // Close channel after 10 minutes
        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch (e) {
            console.error('Error deleting channel:', e);
          }
        }, 600000);
        
      } catch (error) {
        console.error('Release error:', error);
        await interaction.channel.send(`❌ Release failed: ${error.message}\nPlease contact the owner to manually release the funds.`);
      }
    });

    collector.on('end', (collected, reason) => {
      if (reason === 'time') {
        interaction.channel.send('⏰ Timed out waiting for receiver address. Use `/release` command or contact owner.');
      }
    });

  } catch (error) {
    console.error('Release handler error:', error);
    await interaction.followUp({ content: `❌ Error: ${error.message}`, ephemeral: true });
  }
}

// ============================================
// HANDLE SENDER REFUND
// ============================================
async function handleSenderRefund(interaction) {
  const ticketId = interaction.customId.replace('sender_refund_', '');
  const ticket = activeTickets.get(ticketId);
  
  if (!ticket) {
    return interaction.reply({ content: '❌ Trade not found or already completed.', ephemeral: true });
  }
  
  if (interaction.user.id !== ticket.sender) {
    return interaction.reply({ content: '❌ Only the sender can request a refund.', ephemeral: true });
  }

  if (ticket.status !== 'funded') {
    return interaction.reply({ content: '❌ No funds in escrow to refund.', ephemeral: true });
  }

  await interaction.deferReply();

  try {
    // Ask for sender refund address
    const filter = m => m.author.id === ticket.sender;
    
    const askEmbed = new EmbedBuilder()
      .setTitle('🔄 Request Refund')
      .setDescription(`<@${ticket.sender}> **Please provide your LTC address for the refund**`)
      .setColor(0xe74c3c);

    await interaction.followUp({ 
      content: `<@${ticket.sender}>`,
      embeds: [askEmbed]
    });

    const collector = interaction.channel.createMessageCollector({ 
      filter, 
      max: 1, 
      time: 600000
    });

    collector.on('collect', async (msg) => {
      const refundAddress = msg.content.trim();
      
      // Validate
      if (!refundAddress || refundAddress.length < 26) {
        return interaction.channel.send('❌ Invalid LTC address format.');
      }

      try {
        const processingEmbed = new EmbedBuilder()
          .setTitle('⏳ Processing Refund')
          .setDescription('Sending funds back to sender...')
          .setColor(0xf39c12);
        
        await interaction.channel.send({ embeds: [processingEmbed] });
        
        // Send from INDEX 0
        const result = await sendAllLTC(refundAddress, FEE_LTC);
        
        const ltcPrice = await getLtcPriceUSD();
        const usdValue = (result.amount * ltcPrice).toFixed(2);
        
        const successEmbed = new EmbedBuilder()
          .setTitle('🔄 Refund Processed')
          .setDescription(`Funds have been refunded to the sender!`)
          .addFields(
            { name: '💰 Amount Refunded', value: `${result.amount.toFixed(8)} LTC ($${usdValue})`, inline: true },
            { name: '⚡ Fee Deducted', value: `${FEE_LTC} LTC`, inline: true },
            { name: '📤 Refund Address', value: `\`${refundAddress}\``, inline: false },
            { name: '🔗 Transaction', value: `[View on BlockCypher](https://live.blockcypher.com/ltc/tx/${result.txHash}/)` },
            { name: '📍 Sent From', value: 'Index 0 Wallet', inline: true },
            { name: '✅ Status', value: 'Refunded', inline: true }
          )
          .setColor(0xe74c3c)
          .setTimestamp();

        await interaction.channel.send({ embeds: [successEmbed] });
        
        ticket.status = 'refunded';
        
        // Update database
        updateTicketStatus(ticketId, 'refunded', { 
          txHash: result.txHash,
          completedAt: new Date().toISOString()
        });
        
        // Close channel after 10 minutes
        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch (e) {
            console.error('Error deleting channel:', e);
          }
        }, 600000);
        
      } catch (error) {
        console.error('Refund error:', error);
        await interaction.channel.send(`❌ Refund failed: ${error.message}\nPlease contact the owner to manually process the refund.`);
      }
    });

    collector.on('end', (collected, reason) => {
      if (reason === 'time') {
        interaction.channel.send('⏰ Timed out waiting for refund address. Use `/refund` command or contact owner.');
      }
    });

  } catch (error) {
    console.error('Refund handler error:', error);
    await interaction.followUp({ content: `❌ Error: ${error.message}`, ephemeral: true });
  }
}

// ============================================
// HANDLE RECEIVER CONFIRM (Info only)
// ============================================
async function handleReceiverConfirm(interaction) {
  return interaction.reply({ 
    content: '❌ Only the sender can release funds from escrow. Please wait for the sender to confirm they received your payment/item.', 
    ephemeral: true 
  });
}

// ============================================
// HANDLE CANCEL
// ============================================
async function handleCancel(interaction) {
  const ticketId = interaction.customId.replace('cancel_', '');
  const ticket = activeTickets.get(ticketId);
  
  if (!ticket) {
    return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
  }
  
  if (interaction.user.id !== ticket.sender && interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Only sender or owner can cancel.', ephemeral: true });
  }

  if (ticket.status === 'funded') {
    return interaction.reply({ 
      content: '❌ Cannot cancel - funds already deposited. Use refund option instead.', 
      ephemeral: true 
    });
  }

  // Clear intervals
  if (ticket.monitorInterval) {
    clearInterval(ticket.monitorInterval);
    depositMonitors.delete(ticketId);
  }
  if (ticket.confirmInterval) {
    clearInterval(ticket.confirmInterval);
  }
  
  // Update database
  updateTicketStatus(ticketId, 'cancelled');
  activeTickets.delete(ticketId);
  
  const cancelEmbed = new EmbedBuilder()
    .setTitle('❌ Trade Cancelled')
    .setDescription('This trade has been cancelled by the sender.')
    .setColor(0x95a5a6);
  
  await interaction.reply({ embeds: [cancelEmbed] });
  
  // Delete channel after 10 seconds
  setTimeout(async () => {
    try {
      await interaction.channel.delete();
    } catch (e) {
      console.error('Error deleting channel:', e);
    }
  }, 10000);
}

// ============================================
// HANDLE CONFIRM DEPOSIT (Manual check)
// ============================================
async function handleConfirmDeposit(interaction) {
  const ticketId = interaction.customId.replace('confirm_deposit_', '');
  const ticket = activeTickets.get(ticketId);
  
  if (!ticket) {
    return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
  }
  
  if (interaction.user.id !== ticket.sender) {
    return interaction.reply({ content: '❌ Only sender can confirm.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  
  try {
    const balance = await getBalance();
    
    if (balance.confirmed >= ticket.ltcAmount * 0.85) {
      await handleConfirmedDeposit(ticketId, interaction.channel, balance.confirmed, await getLtcPriceUSD());
      await interaction.editReply({ content: '✅ Deposit confirmed!' });
    } else if (balance.unconfirmed > 0) {
      await interaction.editReply({ 
        content: `⏳ Deposit detected but not confirmed yet. Unconfirmed: ${balance.unconfirmed} LTC. Please wait...` 
      });
    } else {
      await interaction.editReply({ 
        content: `❌ No deposit detected at index 0. Balance: ${balance.total} LTC` 
      });
    }
  } catch (error) {
    await interaction.editReply({ content: `❌ Error: ${error.message}` });
  }
}

// ============================================
// OWNER: /release
// ============================================
async function handleOwnerRelease(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Owner only command.', ephemeral: true });
  }

  const channelId = interaction.options.getString('channelid');
  const receiverAddress = interaction.options.getString('receiver_address');
  
  await interaction.deferReply();

  try {
    // Find ticket by channel
    let ticket = null;
    let ticketId = null;
    for (const [tid, tdata] of activeTickets) {
      if (tdata.channelId === channelId) {
        ticket = tdata;
        ticketId = tid;
        break;
      }
    }

    if (!ticket) {
      return interaction.editReply({ content: '❌ No active trade found in that channel.' });
    }

    const result = await sendAllLTC(receiverAddress, FEE_LTC);
    
    const embed = new EmbedBuilder()
      .setTitle('✅ Owner Release Complete')
      .addFields(
        { name: 'Ticket', value: ticketId, inline: true },
        { name: 'Amount', value: `${result.amount.toFixed(8)} LTC`, inline: true },
        { name: 'To', value: `\`${receiverAddress}\``, inline: false },
        { name: 'Tx Hash', value: `\`${result.txHash}\`` }
      )
      .setColor(0x2ecc71);

    await interaction.editReply({ embeds: [embed] });
    
    ticket.status = 'completed_owner';
    updateTicketStatus(ticketId, 'completed_owner', { 
      txHash: result.txHash,
      completedAt: new Date().toISOString()
    });
    
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed: ${error.message}` });
  }
}

// ============================================
// OWNER: /refund
// ============================================
async function handleOwnerRefund(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Owner only command.', ephemeral: true });
  }

  const channelId = interaction.options.getString('channelid');
  const senderAddress = interaction.options.getString('sender_address');
  
  await interaction.deferReply();

  try {
    // Find ticket by channel
    let ticket = null;
    let ticketId = null;
    for (const [tid, tdata] of activeTickets) {
      if (tdata.channelId === channelId) {
        ticket = tdata;
        ticketId = tid;
        break;
      }
    }

    if (!ticket) {
      return interaction.editReply({ content: '❌ No active trade found in that channel.' });
    }

    const result = await sendAllLTC(senderAddress, FEE_LTC);
    
    const embed = new EmbedBuilder()
      .setTitle('🔄 Owner Refund Complete')
      .addFields(
        { name: 'Ticket', value: ticketId, inline: true },
        { name: 'Amount', value: `${result.amount.toFixed(8)} LTC`, inline: true },
        { name: 'To', value: `\`${senderAddress}\``, inline: false },
        { name: 'Tx Hash', value: `\`${result.txHash}\`` }
      )
      .setColor(0xe74c3c);

    await interaction.editReply({ embeds: [embed] });
    
    ticket.status = 'refunded_owner';
    updateTicketStatus(ticketId, 'refunded_owner', { 
      txHash: result.txHash,
      completedAt: new Date().toISOString()
    });
    
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed: ${error.message}` });
  }
}

// ============================================
// OWNER: /close
// ============================================
async function handleClose(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ Owner only.', ephemeral: true });
  }

  const channelId = interaction.options.getString('channelid');
  
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      return interaction.reply({ content: '❌ Channel not found.', ephemeral: true });
    }

    await interaction.reply({ content: `🔒 Closing channel ${channelId}...` });
    await channel.delete();
    
  } catch (error) {
    await interaction.reply({ content: `❌ Error: ${error.message}`, ephemeral: true });
  }
}

// ============================================
// USER: /status
// ============================================
async function handleStatus(interaction) {
  // Find user's active ticket
  let userTicket = null;
  for (const [id, ticket] of activeTickets) {
    if ((ticket.sender === interaction.user.id || ticket.receiver === interaction.user.id) && 
        ['waiting_deposit', 'funded'].includes(ticket.status)) {
      userTicket = ticket;
      break;
    }
  }

  if (!userTicket) {
    return interaction.reply({ 
      content: '❌ You have no active trades.', 
      ephemeral: true 
    });
  }

  const balance = await getBalance();
  const ltcPrice = await getLtcPriceUSD();
  
  const embed = new EmbedBuilder()
    .setTitle(`📊 Trade Status: ${userTicket.id}`)
    .addFields(
      { name: 'Status', value: userTicket.status, inline: true },
      { name: 'Amount', value: `${userTicket.ltcAmount} LTC`, inline: true },
      { name: 'Escrow Balance', value: `${balance.total.toFixed(8)} LTC`, inline: true },
      { name: 'Channel', value: `<#${userTicket.channelId}>`, inline: false }
    )
    .setColor(userTicket.status === 'funded' ? 0x2ecc71 : 0xf39c12);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ============================================
// USER: /send
// ============================================
async function handleSend(interaction) {
  const address = interaction.options.getString('address');
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // Check INDEX 0 balance first
    const balance = await getBalance();
    
    if (balance.total <= 0) {
      return interaction.editReply({ 
        content: `❌ No LTC found at index 0.\nAddress: ${balance.address}`,
      });
    }

    const result = await sendAllLTC(address, FEE_LTC);
    
    const embed = new EmbedBuilder()
      .setTitle('✅ Transaction Sent from Index 0')
      .addFields(
        { name: '💰 Amount', value: `${result.amount.toFixed(8)} LTC`, inline: true },
        { name: '⚡ Fee', value: `${result.fee} LTC`, inline: true },
        { name: '📤 To', value: `\`${address}\``, inline: false },
        { name: '🔗 Tx Hash', value: `\`${result.txHash}\`` },
        { name: '📍 From', value: 'Index 0', inline: true }
      )
      .setColor(0x2ecc71);

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    await interaction.editReply({ 
      content: `❌ Transaction failed: ${error.message}`,
    });
  }
}

// ============================================
// USER: /balance
// ============================================
async function handleBalance(interaction) {
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // INDEX 0 ONLY
    const balance = await getBalance();
    const ltcPrice = await getLtcPriceUSD();
    const usdValue = (balance.total * ltcPrice).toFixed(2);
    const confirmedUsd = (balance.confirmed * ltcPrice).toFixed(2);
    
    const embed = new EmbedBuilder()
      .setTitle('💰 Wallet Balance (INDEX 0 ONLY)')
      .addFields(
        { name: '✅ Confirmed', value: `${balance.confirmed.toFixed(8)} LTC ($${confirmedUsd})`, inline: true },
        { name: '⏳ Unconfirmed', value: `${balance.unconfirmed.toFixed(8)} LTC`, inline: true },
        { name: '💵 Total', value: `${balance.total.toFixed(8)} LTC ($${usdValue})`, inline: false },
        { name: '📍 Index 0 Address', value: `\`${balance.address}\`` },
        { name: '🔑 Path', value: '`m/84\'/2\'/0\'/0/0`', inline: true }
      )
      .setColor(0x3498db)
      .setFooter({ text: 'This bot uses Index 0 only - No HD scanning' });

    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    await interaction.editReply({ content: `❌ Error: ${error.message}` });
  }
}

// ============================================
// USER: /address
// ============================================
async function handleAddress(interaction) {
  const address = getAddress();
  
  const embed = new EmbedBuilder()
    .setTitle('📍 Your LTC Address (INDEX 0)')
    .setDescription(`\`${address}\``)
    .addFields(
      { name: 'Path', value: '`m/84\'/2\'/0\'/0/0`', inline: true },
      { name: 'Type', value: 'Native SegWit (P2WPKH)', inline: true },
      { name: 'Note', value: 'Send LTC here for escrow. This is the ONLY address used by the bot.' }
    )
    .setColor(0x3498db)
    .setFooter({ text: 'Index 0 Only' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ============================================
// BACKGROUND TASKS
// ============================================
function startBackgroundTasks() {
  // Clean up old tickets every hour
  setInterval(() => {
    const now = Date.now();
    for (const [id, ticket] of activeTickets) {
      if (ticket.status === 'completed' || ticket.status === 'refunded' || ticket.status === 'cancelled') {
        const age = now - new Date(ticket.completedAt || ticket.createdAt).getTime();
        if (age > 24 * 60 * 60 * 1000) { // 24 hours
          activeTickets.delete(id);
          console.log(`🧹 Cleaned up old ticket: ${id}`);
        }
      }
    }
  }, 60 * 60 * 1000);
  
  console.log('✅ Background tasks started');
}

// ============================================
// ERROR HANDLING
// ============================================
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  db.close();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  db.close();
  client.destroy();
  process.exit(0);
});

// ============================================
// LOGIN
// ============================================
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login:', err);
  process.exit(1);
});
