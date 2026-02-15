require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
  ButtonBuilder, ButtonStyle, Events, PermissionsBitField, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle 
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { initWallet, getDepositAddress } = require('./wallet');

const db = new sqlite3.Database('./trades.db');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const OWNER_ID = 'YOUR_OWNER_ID';
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_LTC_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';

// ---------------- Initialize Wallet ----------------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  initWallet(process.env.BOT_MNEMONIC);
});

// ---------------- Database Setup ----------------
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS activated_users (user_id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT,
    sender_id TEXT,
    receiver_id TEXT,
    you_give TEXT,
    they_give TEXT,
    amount REAL,
    fee REAL,
    deposit_addr TEXT,
    status TEXT DEFAULT 'waiting_role'
  )`);
});

// ---------------- Helper Functions ----------------
function calculateFee(value){
  if(value <= 5) return 0;
  if(value <= 10) return 0.3;
  if(value <= 50) return 0.7;
  if(value <= 100) return 1;
  if(value > 250) return 2;
  return 0;
}

function sendEmbed(channel, title, description, color='#00aaff', components=[]){
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color);
  return channel.send({ embeds:[embed], components });
}

// ---------------- Commands ----------------
client.on(Events.InteractionCreate, async interaction => {
  if(interaction.isCommand()){
    const { commandName } = interaction;

    // Owner generates key
    if(commandName === 'generatekey'){
      if(interaction.user.id !== OWNER_ID)
        return interaction.reply({ content:'Only owner.', ephemeral:true });
      const key = Math.random().toString(36).substring(2,18).toUpperCase();
      db.run('INSERT INTO keys(key) VALUES(?)', key);
      return interaction.reply({ content:`Key: \`${key}\``, ephemeral:true });
    }

    // Redeem key
    if(commandName === 'redeemkey'){
      const key = interaction.options.getString('key').toUpperCase();
      if(interaction.user.id === OWNER_ID) 
        return interaction.reply({ content:"Owner doesn't need key.", ephemeral:true });
      db.get('SELECT used FROM keys WHERE key=?', key, (err,row)=>{
        if(err || !row || row.used) return interaction.reply({ content:'Invalid/used key.', ephemeral:true });
        db.run('UPDATE keys SET used=1 WHERE key=?', key);
        db.run('INSERT OR IGNORE INTO activated_users(user_id) VALUES(?)', interaction.user.id);
        return interaction.reply({ content:'Activated!', ephemeral:true });
      });
    }

    // LTC Panel
    if(commandName === 'autoticketpanel'){
      db.get('SELECT 1 FROM activated_users WHERE user_id=?', interaction.user.id, (err,row)=>{
        if(interaction.user.id !== OWNER_ID && !row)
          return interaction.reply({ content:'Redeem a key first.', ephemeral:true });

        sendEmbed(interaction.channel, 'Litecoin Escrow Panel', 'Start LTC Trade with button below', '#00aaff', [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('start_trade')
              .setLabel('Start LTC Trade')
              .setStyle(ButtonStyle.Primary)
          )
        ]);
        interaction.reply({ content:'Panel loaded', ephemeral:true });
      });
    }
  }

  // ---------------- Button Handling ----------------
  if(interaction.isButton()){
    const [action, tradeId, extra] = interaction.customId.split('_');

    // Start Trade Modal
    if(interaction.customId === 'start_trade'){
      const modal = new ModalBuilder()
        .setCustomId('trade_modal')
        .setTitle('Start LTC Trade')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('other_user')
              .setLabel('User/ID of other person')
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
      return interaction.showModal(modal);
    }

    // Choose roles
    if(action === 'choose'){
      db.get('SELECT * FROM trades WHERE id=?', tradeId, (err,row)=>{
        if(!row) return interaction.reply({ content:'Trade not found', ephemeral:true });

        if(extra === 'sender'){
          if(row.sender_id) return interaction.reply({ content:'Sender already chosen', ephemeral:true });
          db.run('UPDATE trades SET sender_id=? WHERE id=?', [interaction.user.id, tradeId]);
        }
        if(extra === 'receiver'){
          if(row.receiver_id) return interaction.reply({ content:'Receiver already chosen', ephemeral:true });
          db.run('UPDATE trades SET receiver_id=? WHERE id=?', [interaction.user.id, tradeId]);
        }

        db.get('SELECT sender_id, receiver_id FROM trades WHERE id=?', tradeId, (e,r)=>{
          if(r.sender_id && r.receiver_id){
            sendEmbed(interaction.channel, 'Both roles chosen', 'Confirm Trade below', '#00ff00', [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`confirm_trade_${tradeId}`).setLabel('Confirm Trade').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`cancel_trade_${tradeId}`).setLabel('No').setStyle(ButtonStyle.Danger)
              )
            ]);
          }
        });
      });
    }

    // Confirm trade
    if(action === 'confirm' && extra === 'trade'){
      db.run('UPDATE trades SET status=? WHERE id=?', ['confirmed', tradeId]);
      sendEmbed(interaction.channel, 'Trade Confirmed', 'Sender, input the deal value using modal', '#00aaff');
    }

    // Release / Refund
    if(action === 'release'){
      db.get('SELECT sender_id FROM trades WHERE id=?', tradeId, (err,row)=>{
        if(!row) return;
        if(interaction.user.id !== row.sender_id && interaction.user.id !== OWNER_ID) 
          return interaction.reply({ content:'Only sender/owner can release', ephemeral:true });
        sendEmbed(interaction.channel, 'Release Selected', 'Sender, input LTC address using modal', '#00ff00');
      });
    }

    if(action === 'refund'){
      db.get('SELECT sender_id, receiver_id FROM trades WHERE id=?', tradeId, (err,row)=>{
        if(!row) return;
        if(interaction.user.id !== row.sender_id && interaction.user.id !== OWNER_ID)
          return interaction.reply({ content:'Only sender/owner can refund', ephemeral:true });
        sendEmbed(interaction.channel, 'Refund Requested', 'Confirm Refund', '#ff0000');
      });
    }
  }

  // ---------------- Modal Handling ----------------
  if(interaction.isModalSubmit()){
    if(interaction.customId === 'trade_modal'){
      const otherInput = interaction.fields.getTextInputValue('other_user');
      const youGive = interaction.fields.getTextInputValue('you_give');
      const theyGive = interaction.fields.getTextInputValue('they_give');

      let otherUser;
      try {
        const id = otherInput.replace(/[<@!>]/g,'');
        otherUser = await client.users.fetch(id);
      } catch(err){
        return interaction.reply({ content:'Invalid user.', ephemeral:true });
      }

      if(otherUser.id === interaction.user.id)
        return interaction.reply({ content:"Can't trade with yourself.", ephemeral:true });

      // Create trade ticket
      db.run('INSERT INTO trades(channel_id,status,you_give,they_give) VALUES (?,?,?,?)', ['pending','waiting_role',youGive,theyGive], function(err){
        if(err) return interaction.reply({ content:'DB error', ephemeral:true });
        const tradeId = this.lastID;
        const depositAddr = getDepositAddress(tradeId);

        interaction.guild.channels.create({
          name:`trade-${tradeId}`,
          type:ChannelType.GuildText,
          permissionOverwrites:[
            { id:interaction.guild.roles.everyone.id, deny:[PermissionsBitField.Flags.ViewChannel]},
            { id:interaction.user.id, allow:[PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]},
            { id:otherUser.id, allow:[PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]}
          ]
        }).then(ch=>{
          db.run('UPDATE trades SET channel_id=?, deposit_addr=? WHERE id=?', [ch.id, depositAddr, tradeId]);
          sendEmbed(ch, `Litecoin Trade #${tradeId}`, 
            `Deposit Address: ${depositAddr}\n**${interaction.user} gives:** ${youGive}\n**${otherUser} gives:** ${theyGive}`, '#00aaff', [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`choose_${tradeId}_sender`).setLabel('Sender').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`choose_${tradeId}_receiver`).setLabel('Receiver').setStyle(ButtonStyle.Primary)
            )
          ]);
          interaction.reply({ content:`Trade ticket created: ${ch}`, ephemeral:true });
        });
      });
    }
  }
});

// ---------------- Owner Force Commands ----------------
client.on(Events.MessageCreate, async message => {
  if(message.author.bot) return;
  const args = message.content.split(' ');

  if(message.author.id === OWNER_ID){
    if(args[0] === '$release'){
      const tradeId = args[1];
      sendEmbed(message.channel, `Force Release Executed`, `Trade #${tradeId} released by owner`, '#00ff00');
    }
    if(args[0] === '$refund'){
      const tradeId = args[1];
      sendEmbed(message.channel, `Force Refund Executed`, `Trade #${tradeId} refunded by owner`, '#ff0000');
    }
  }
});

// ---------------- Login ----------------
client.login(TOKEN);
