require('dotenv').config();
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
  ChannelType
} = require('discord.js');
const db = require('./database');
const { getAddress, getBalance, sendAllLTC, getWalletAtIndex0 } = require('./wallet');
const { getLtcPriceUSD, getAddressInfo, getTransaction } = require('./blockchain');

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

const OWNER_ID = process.env.OWNER_ID || '1298640383688970293';
const FEE_LTC = 0.001;
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
const TICKET_CATEGORY = process.env.TICKET_CATEGORY || null;

// Store active tickets in memory and database
const activeTickets = new Map();
const depositMonitors = new Map();

// Deploy commands
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
    .setDescription('Check balance of index 0'),
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
        .setDescription('LTC address of receiver')
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
        .setDescription('LTC address to refund to')
        .setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error refreshing commands:', error);
  }
})();

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`✅ Bot is ready and operational!`);
  console.log(`✅ Using INDEX 0 ONLY - Single Address Mode`);
  console.log(`✅ Fee Address: ${FEE_ADDRESS}`);
  
  // Load active tickets from database
  loadActiveTickets();
});

// Load tickets from database
function loadActiveTickets() {
  try {
    const stmt = db.prepare('SELECT * FROM tickets WHERE status IN (?, ?)');
    const tickets = stmt.all('waiting_deposit', 'funded');
    
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
        createdAt: ticket.created_at
      });
      
      // Resume monitoring if waiting for deposit
      if (ticket.status === 'waiting_deposit') {
        const channel = client.channels.cache.get(ticket.channel_id);
        if (channel) {
          monitorDeposit(ticket.ticket_id, channel, parseFloat(ticket.ltc_amount));
        }
      }
    }
    console.log(`✅ Loaded ${tickets.length} active tickets from database`);
  } catch (error) {
    console.error('Error loading tickets:', error);
  }
}

// Command handler
client.on('interactionCreate', async (interaction) => {
  try {
    // Slash Commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') {
        await handlePanel(interaction);
      }
      else if (interaction.commandName === 'send') {
        await handleSend(interaction);
      }
      else if (interaction.commandName === 'balance') {
        await handleBalance(interaction);
      }
      else if (interaction.commandName === 'address') {
        await handleAddress(interaction);
      }
      else if (interaction.commandName === 'release') {
        await handleOwnerRelease(interaction);
      }
      else if (interaction.commandName === 'refund') {
        await handleOwnerRefund(interaction);
      }
    }
    
    // Button Interactions
    else if (interaction.isButton()) {
      if (interaction.customId === 'create_ticket') {
        await showTicketModal(interaction);
      }
      else if (interaction.customId.startsWith('confirm_deposit_')) {
        await handleConfirmDeposit(interaction);
      }
      else if (interaction.customId.startsWith('cancel_')) {
        await handleCancel(interaction);
      }
      else if (interaction.customId.startsWith('sender_release_')) {
        await handleSenderRelease(interaction);
      }
      else if (interaction.customId.startsWith('sender_refund_')) {
        await handleSenderRefund(interaction);
      }
      else if (interaction.customId.startsWith('receiver_confirm_')) {
        await handleReceiverConfirm(interaction);
      }
    }
    
    // Modal Submit
    else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'ticket_modal') {
        await createTicket(interaction);
      }
    }
    
    // Select Menu
    else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'trade_action') {
        await handleTradeActionSelect(interaction);
      }
    }
    
  } catch (error) {
    console.error('Interaction error:', error);
    const reply = { content: '❌ An error occurred. Please try again.', ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (e) {
      console.error('Error sending error message:', e);
    }
  }
});

// /panel command
async function handlePanel(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ This command is for the owner only.', ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle('Schior\'s Auto Middleman Service')
    .setDescription('Welcome to the automated middleman service!\n\nCreate a secure trade and the bot will hold the LTC in escrow until both parties confirm.\n\nClick the button below to create a new trade.')
    .setColor(0x3498db)
    .setTimestamp()
    .setFooter({ text: 'Secure • Fast • Automated' });

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('create_ticket')
        .setLabel('🎫 Create Trade')
        .setStyle(ButtonStyle.Primary)
    );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// Show ticket creation modal
async function showTicketModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('ticket_modal')
    .setTitle('Create Trade Ticket');

  const givingInput = new TextInputBuilder()
    .setCustomId('giving')
    .setLabel('What are YOU giving?')
    .setPlaceholder('e.g. 100 LTC, NFT, Item, Service...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const receivingInput = new TextInputBuilder()
    .setCustomId('receiving')
    .setLabel('What is he/she giving?')
    .setPlaceholder('e.g. PayPal $500, Crypto, Item...')
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

  const row1 = new ActionRowBuilder().addComponents(givingInput);
  const row2 = new ActionRowBuilder().addComponents(receivingInput);
  const row3 = new ActionRowBuilder().addComponents(otherPartyInput);
  const row4 = new ActionRowBuilder().addComponents(ltcAmountInput);

  modal.addComponents(row1, row2, row3, row4);

  await interaction.showModal(modal);
}

// Create ticket
async function createTicket(interaction) {
  const giving = interaction.fields.getTextInputValue('giving');
  const receiving = interaction.fields.getTextInputValue('receiving');
  const otherPartyRaw = interaction.fields.getTextInputValue('other_party');
  const ltcAmount = parseFloat(interaction.fields.getTextInputValue('ltc_amount'));

  if (isNaN(ltcAmount) || ltcAmount <= 0) {
    return interaction.reply({ content: '❌ Invalid LTC amount. Please enter a positive number.', ephemeral: true });
  }

  // Parse other party ID
  let otherPartyId = otherPartyRaw.replace(/[<@!>]/g, '');
  
  if (otherPartyId === interaction.user.id) {
    return interaction.reply({ content: '❌ You cannot trade with yourself!', ephemeral: true });
  }

  try {
    const otherMember = await interaction.guild.members.fetch(otherPartyId).catch(() => null);
    
    if (!otherMember) {
      return interaction.reply({ content: '❌ Could not find the other user. Make sure they are in this server.', ephemeral: true });
    }

    // INDEX 0 ADDRESS - ONLY ONE ADDRESS
    const escrowAddress = getAddress();
    const ticketId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    // Store ticket data
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
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]
        },
        {
          id: otherPartyId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]
        },
        {
          id: client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels]
        }
      ]
    };

    if (TICKET_CATEGORY) {
      channelOptions.parent = TICKET_CATEGORY;
    }

    const channel = await interaction.guild.channels.create(channelOptions);

    activeTickets.get(ticketId).channelId = channel.id;

    // Save to database
    try {
      const stmt = db.prepare(`INSERT INTO tickets 
        (ticket_id, sender_id, receiver_id, giving, receiving, ltc_amount, escrow_address, status, channel_id, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      stmt.run(ticketId, interaction.user.id, otherPartyId, giving, receiving, ltcAmount, escrowAddress, 'waiting_deposit', channel.id, ticketData.createdAt);
    } catch (dbError) {
      console.error('Database error:', dbError);
    }

    const ltcPrice = await getLtcPriceUSD();
    const usdValue = (ltcAmount * ltcPrice).toFixed(2);
    const totalWithFee = ltcAmount + FEE_LTC;
    const totalUsd = (totalWithFee * ltcPrice).toFixed(2);

    const embed = new EmbedBuilder()
      .setTitle(`🤝 Trade #${ticketId}`)
      .setDescription(`**Status:** ⏳ Waiting for deposit\n\n**${interaction.user.username}** is giving: **${giving}**\n**${otherMember.user.username}** is giving: **${receiving}**`)
      .addFields(
        { name: '💰 Required Deposit', value: `${ltcAmount} LTC ($${usdValue})`, inline: true },
        { name: '⚡ Network Fee', value: `${FEE_LTC} LTC`, inline: true },
        { name: '💵 Total to Send', value: `${totalWithFee.toFixed(6)} LTC ($${totalUsd})`, inline: true },
        { name: '📍 Deposit Address (INDEX 0)', value: `\`${escrowAddress}\`` },
        { name: '🔑 Sender', value: `<@${interaction.user.id}>`, inline: true },
        { name: '👤 Receiver', value: `<@${otherPartyId}>`, inline: true }
      )
      .setColor(0xf39c12)
      .setTimestamp()
      .setFooter({ text: 'Send exact amount including fee • Using Index 0' });

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_${ticketId}`)
          .setLabel('❌ Cancel Trade')
          .setStyle(ButtonStyle.Danger)
      );

    const msg = await channel.send({ 
      content: `<@${interaction.user.id}> <@${otherPartyId}>`,
      embeds: [embed], 
      components: [row] 
    });
    
    activeTickets.get(ticketId).messageId = msg.id;

    // Update database with message ID
    try {
      const stmt = db.prepare('UPDATE tickets SET message_id = ? WHERE ticket_id = ?');
      stmt.run(msg.id, ticketId);
    } catch (dbError) {
      console.error('Database update error:', dbError);
    }

    // Start monitoring INDEX 0 for deposit
    monitorDeposit(ticketId, channel, ltcAmount);

    await interaction.reply({ 
      content: `✅ Trade created! Channel: <#${channel.id}>\n\n**Send ${totalWithFee.toFixed(6)} LTC to:**\n\`${escrowAddress}\`\n\nMake sure to send the exact amount including the ${FEE_LTC} LTC fee!`, 
      ephemeral: true 
    });

  } catch (error) {
    console.error('Create ticket error:', error);
    await interaction.reply({ content: `❌ Error creating trade: ${error.message}`, ephemeral: true });
  }
}

// Monitor deposit on INDEX 0 ONLY
async function monitorDeposit(ticketId, channel, expectedAmount) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket) return;

  console.log(`[Monitor] Starting deposit monitor for ticket ${ticketId} on INDEX 0`);

  let checkCount = 0;
  let lastTxHash = null;

  const checkInterval = setInterval(async () => {
    try {
      checkCount++;
      
      // INDEX 0 BALANCE CHECK ONLY - NO LOOPS
      const balance = await getBalance();
      
      const confirmedLTC = balance.confirmed;
      const unconfirmedLTC = balance.unconfirmed;
      const totalLTC = balance.total;

      console.log(`[Ticket ${ticketId}] Check #${checkCount} | Index 0 - Confirmed: ${confirmedLTC}, Unconfirmed: ${unconfirmedLTC}`);

      // Check if we have any funds
      if (unconfirmedLTC > 0 || confirmedLTC > 0) {
        
        // Check if amount is sufficient (within 10% tolerance for fees)
        const detectedAmount = confirmedLTC > 0 ? confirmedLTC : unconfirmedLTC;
        
        if (detectedAmount < expectedAmount * 0.85) {
          console.log(`[Ticket ${ticketId}] Amount too low: ${detectedAmount} LTC, expected: ${expectedAmount}`);
          // Don't clear interval, keep waiting for more
        } else {
          clearInterval(checkInterval);
          depositMonitors.delete(ticketId);
          
          const ltcPrice = await getLtcPriceUSD();
          
          if (unconfirmedLTC > 0 && confirmedLTC < expectedAmount * 0.85) {
            // Unconfirmed deposit detected
            const usdValue = (unconfirmedLTC * ltcPrice).toFixed(2);
            
            const embed = new EmbedBuilder()
              .setTitle(`🤝 Trade #${ticketId}`)
              .setDescription(`**Status:** ⏳ Deposit detected (unconfirmed)\n\nTransaction found on blockchain, waiting for confirmation...`)
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
      
      // Timeout after 200 checks (approx 33 minutes)
      if (checkCount > 200) {
        clearInterval(checkInterval);
        depositMonitors.delete(ticketId);
        await channel.send('⏰ Deposit monitoring timed out. If you already sent funds, please contact the owner.');
      }
      
    } catch (error) {
      console.error(`[Ticket ${ticketId}] Monitor error:`, error);
    }
  }, 10000); // Check every 10 seconds

  depositMonitors.set(ticketId, checkInterval);
  ticket.monitorInterval = checkInterval;
}

// Monitor for confirmation on INDEX 0
async function monitorConfirmation(ticketId, channel, expectedAmount) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket) return;

  console.log(`[Monitor] Starting confirmation monitor for ticket ${ticketId}`);

  let checkCount = 0;
  const confirmInterval = setInterval(async () => {
    try {
      checkCount++;
      
      // INDEX 0 ONLY
      const balance = await getBalance();
      const confirmedLTC = balance.confirmed;

      if (confirmedLTC >= expectedAmount * 0.85) {
        clearInterval(confirmInterval);
        if (ticket.confirmInterval) delete ticket.confirmInterval;
        
        const ltcPrice = await getLtcPriceUSD();
        await handleConfirmedDeposit(ticketId, channel, confirmedLTC, ltcPrice);
      }
      
      // Timeout after 120 checks (30 minutes)
      if (checkCount > 120) {
        clearInterval(confirmInterval);
        if (ticket.confirmInterval) delete ticket.confirmInterval;
        await channel.send('⏰ Confirmation monitoring timed out. Funds may still confirm. Contact owner if issues persist.');
      }
      
    } catch (error) {
      console.error(`[Ticket ${ticketId}] Confirmation error:`, error);
    }
  }, 15000);
  
  ticket.confirmInterval = confirmInterval;
}

// Handle confirmed deposit
async function handleConfirmedDeposit(ticketId, channel, amount, ltcPrice) {
  const ticket = activeTickets.get(ticketId);
  if (!ticket || ticket.status !== 'waiting_deposit') return;

  console.log(`[Ticket ${ticketId}] Deposit confirmed: ${amount} LTC`);

  ticket.status = 'funded';
  const usdValue = (amount * ltcPrice).toFixed(2);

  // Update database
  try {
    const stmt = db.prepare('UPDATE tickets SET status = ?, deposit_amount = ? WHERE ticket_id = ?');
    stmt.run('funded', amount, ticketId);
  } catch (dbError) {
    console.error('Database update error:', dbError);
  }

  const embed = new EmbedBuilder()
    .setTitle(`🤝 Trade #${ticketId}`)
    .setDescription(`**Status:** ✅ **FUNDED & CONFIRMED**\n\nThe deposit has been confirmed on the blockchain and is now held in escrow!`)
    .addFields(
      { name: '💰 Confirmed Amount', value: `${amount.toFixed(8)} LTC ($${usdValue})`, inline: true },
      { name: '🔒 Held in Escrow', value: 'Index 0 Wallet', inline: true },
      { name: '🔑 Sender', value: `<@${ticket.sender}>`, inline: true },
      { name: '👤 Receiver', value: `<@${ticket.receiver}>`, inline: true },
      { name: '📋 Trade Details', value: `**Sender gives:** ${ticket.giving}\n**Receiver gives:** ${ticket.receiving}` }
    )
    .setColor(0x2ecc71)
    .setTimestamp();

  // Buttons for sender only
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`sender_release_${ticketId}`)
        .setLabel('✅ Release to Receiver')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sender_refund_${ticketId}`)
        .setLabel('🔄 Refund to Me')
        .setStyle(ButtonStyle.Danger)
    );

  await channel.send({
    content: `<@${ticket.sender}> **Your deposit is confirmed!** The funds are now held in escrow. Choose an action when ready:`,
    embeds: [embed],
    components: [row]
  });
}

// Handle sender release
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
    
    const askMsg = await interaction.followUp({ 
      content: `<@${ticket.receiver}> **Please provide your LTC address to receive ${ticket.ltcAmount} LTC:**\n(Sender <@${ticket.sender}> has authorized the release)`,
    });

    const collector = interaction.channel.createMessageCollector({ 
      filter, 
      max: 1, 
      time: 600000 // 10 minutes
    });

    collector.on('collect', async (msg) => {
      const receiverAddress = msg.content.trim();
      
      // Basic validation
      if (!receiverAddress || receiverAddress.length < 26) {
        return interaction.channel.send('❌ Invalid LTC address format. Please use `/release` command manually or contact owner.');
      }

      try {
        await interaction.channel.send('⏳ Processing release transaction... This may take a moment.');
        
        // Send from INDEX 0
        const result = await sendAllLTC(receiverAddress, FEE_LTC);
        
        const ltcPrice = await getLtcPriceUSD();
        const usdValue = (result.amount * ltcPrice).toFixed(2);
        
        const embed = new EmbedBuilder()
          .setTitle('✅ Trade Complete - Funds Released')
          .setDescription(`The escrow has been released to the receiver!`)
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

        await interaction.channel.send({ embeds: [embed] });
        
        ticket.status = 'completed';
        
        // Update database
        try {
          const stmt = db.prepare('UPDATE tickets SET status = ?, completed_at = ?, tx_hash = ? WHERE ticket_id = ?');
          stmt.run('completed', new Date().toISOString(), result.txHash, ticketId);
        } catch (dbError) {
          console.error('Database update error:', dbError);
        }
        
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

// Handle sender refund
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
    
    await interaction.followUp({ 
      content: `<@${ticket.sender}> **Please provide your LTC address for the refund:**`,
    });

    const collector = interaction.channel.createMessageCollector({ 
      filter, 
      max: 1, 
      time: 600000
    });

    collector.on('collect', async (msg) => {
      const refundAddress = msg.content.trim();
      
      try {
        await interaction.channel.send('⏳ Processing refund...');
        
        // Send from INDEX 0
        const result = await sendAllLTC(refundAddress, FEE_LTC);
        
        const ltcPrice = await getLtcPriceUSD();
        const usdValue = (result.amount * ltcPrice).toFixed(2);
        
        const embed = new EmbedBuilder()
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

        await interaction.channel.send({ embeds: [embed] });
        
        ticket.status = 'refunded';
        
        // Update database
        try {
          const stmt = db.prepare('UPDATE tickets SET status = ?, completed_at = ?, tx_hash = ? WHERE ticket_id = ?');
          stmt.run('refunded', new Date().toISOString(), result.txHash, ticketId);
        } catch (dbError) {
          console.error('Database update error:', dbError);
        }
        
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

// Receiver confirm (they can't actually click, just for info)
async function handleReceiverConfirm(interaction) {
  return interaction.reply({ content: '❌ Only the sender can release funds from escrow.', ephemeral: true });
}

// Owner manual release
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
    
    // Update database
    try {
      const stmt = db.prepare('UPDATE tickets SET status = ?, completed_at = ?, tx_hash = ? WHERE ticket_id = ?');
      stmt.run('completed_owner', new Date().toISOString(), result.txHash, ticketId);
    } catch (dbError) {
      console.error('Database error:', dbError);
    }
    
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed: ${error.message}` });
  }
}

// Owner manual refund
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
    
    // Update database
    try {
      const stmt = db.prepare('UPDATE tickets SET status = ?, completed_at = ?, tx_hash = ? WHERE ticket_id = ?');
      stmt.run('refunded_owner', new Date().toISOString(), result.txHash, ticketId);
    } catch (dbError) {
      console.error('Database error:', dbError);
    }
    
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed: ${error.message}` });
  }
}

// /send command - INDEX 0 ONLY
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

// /balance command - INDEX 0 ONLY
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

// /address command - INDEX 0 ONLY
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

// Handle cancel
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
    return interaction.reply({ content: '❌ Cannot cancel - funds already deposited. Use refund option.', ephemeral: true });
  }

  // Clear intervals
  if (ticket.monitorInterval) {
    clearInterval(ticket.monitorInterval);
    depositMonitors.delete(ticketId);
  }
  if (ticket.confirmInterval) clearInterval(ticket.confirmInterval);
  
  // Update database
  try {
    const stmt = db.prepare('UPDATE tickets SET status = ? WHERE ticket_id = ?');
    stmt.run('cancelled', ticketId);
  } catch (dbError) {
    console.error('Database error:', dbError);
  }
  
  activeTickets.delete(ticketId);
  
  await interaction.reply({ content: '❌ Trade cancelled.', ephemeral: false });
  
  setTimeout(async () => {
    try {
      await interaction.channel.delete();
    } catch (e) {
      console.error('Error deleting channel:', e);
    }
  }, 5000);
}

// Handle trade action select (if used)
async function handleTradeActionSelect(interaction) {
  // Implementation if needed
}

// Login
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});
