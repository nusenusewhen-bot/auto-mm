import discord
from discord import app_commands, SelectOption
from discord.ui import View, Select, Modal, TextInput
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
import time
from bitcoinlib.wallets import Wallet, wallet_exists, WalletError

# ────────────────────────────────────────────────
# Environment variables (Railway)
# ────────────────────────────────────────────────
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
MNEMONIC = os.getenv('BOT_MNEMONIC')

if not TOKEN:
    print("DISCORD_TOKEN missing")
    exit(1)

# ────────────────────────────────────────────────
# Litecoin wallet – create or open existing
# ────────────────────────────────────────────────
wallet = None
if MNEMONIC:
    WALLET_NAME = "AutoMMBotWallet"
    try:
        if wallet_exists(WALLET_NAME):
            wallet = Wallet(WALLET_NAME)
            print(f"Opened existing wallet '{WALLET_NAME}'")
        else:
            wallet = Wallet.create(
                name=WALLET_NAME,
                keys=MNEMONIC,
                network='litecoin',
                witness_type='segwit'
            )
            print(f"Created new wallet '{WALLET_NAME}'")

        key0 = wallet.key_for_path("m/44'/2'/0'/0/0")
        print(f"Bot personal LTC address #0: {key0.address}")
    except WalletError as e:
        print(f"Wallet error: {e}")
        print("Check BOT_MNEMONIC in Railway Variables")
else:
    print("WARNING: No BOT_MNEMONIC → escrow disabled")

def get_deposit_address(trade_index: int):
    if not wallet:
        return "WALLET_NOT_LOADED"
    key = wallet.key_for_path(f"m/44'/2'/0'/0/{trade_index}")
    return key.address

# ────────────────────────────────────────────────
# Database
# ────────────────────────────────────────────────
conn = sqlite3.connect('trades.db')
c = conn.cursor()
c.execute('''CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)''')
c.execute('''CREATE TABLE IF NOT EXISTS activated_users (user_id TEXT PRIMARY KEY)''')
c.execute('''CREATE TABLE IF NOT EXISTS trades
             (id INTEGER PRIMARY KEY AUTOINCREMENT,
              buyer_id TEXT NOT NULL,
              seller_id TEXT,
              amount REAL,
              currency TEXT NOT NULL,
              deposit_addr TEXT NOT NULL,
              status TEXT DEFAULT 'waiting_deposit',
              channel_id TEXT,
              created_at INTEGER DEFAULT (strftime('%s', 'now')))''')
conn.commit()

# ────────────────────────────────────────────────
# Discord bot
# ────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

OWNER_ID = 1298640383688970293

# ────────────────────────────────────────────────
# Modal for trade setup
# ────────────────────────────────────────────────
class TradeDetailsModal(Modal, title="Trade Setup"):
    other_user_input = TextInput(
        label="User/ID of the other person",
        placeholder="@username or numeric ID (e.g. 123456789012345678)",
        style=discord.TextStyle.short,
        required=True,
        max_length=100
    )

    you_give = TextInput(
        label="What are YOU giving",
        placeholder="e.g. 500 USDT, Roblox acc, gift card code...",
        style=discord.TextStyle.paragraph,
        required=True,
        max_length=500
    )

    they_give = TextInput(
        label="What are THEY giving",
        placeholder="e.g. 0.1 BTC, Steam account, PSN card...",
        style=discord.TextStyle.paragraph,
        required=True,
        max_length=500
    )

    def __init__(self, currency: str):
        super().__init__()
        self.currency = currency

    async def on_submit(self, interaction: discord.Interaction):
        other_input = self.other_user_input.value.strip()
        you_give = self.you_give.value.strip()
        they_give = self.they_give.value.strip()

        # Resolve other user
        other_user = None
        if other_input.startswith('<@') and other_input.endswith('>'):
            try:
                uid_str = other_input[2:-1].replace('!', '')
                other_user = await client.fetch_user(int(uid_str))
            except:
                pass
        else:
            try:
                other_user = await client.fetch_user(int(other_input))
            except:
                pass

        if not other_user:
            return await interaction.response.send_message(
                "Couldn't find that user. Use @mention or correct numeric ID.",
                ephemeral=True
            )

        if other_user.id == interaction.user.id:
            return await interaction.response.send_message("Can't trade with yourself.", ephemeral=True)

        # Unique deposit address
        trade_index = int(time.time() * 1000) % 1000000
        deposit_addr = get_deposit_address(trade_index)

        # Save trade
        c.execute(
            """INSERT INTO trades (buyer_id, currency, deposit_addr, channel_id, status)
               VALUES (?, ?, ?, ?, ?)""",
            (str(interaction.user.id), self.currency, deposit_addr, "pending", 'waiting_role')
        )
        trade_id = c.lastrowid
        conn.commit()

        # Create private channel
        guild = interaction.guild
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            interaction.user: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True),
            other_user: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True),
        }

        channel = await guild.create_text_channel(
            name=f"trade-{trade_id}-{interaction.user.name[:8]}-{other_user.name[:8]}",
            overwrites=overwrites,
            topic=f"Trade #{trade_id} | {self.currency} | {interaction.user} ↔ {other_user}"
        )

        # Update channel ID
        c.execute("UPDATE trades SET channel_id = ? WHERE id = ?", (channel.id, trade_id))
        conn.commit()

        # Role choice view
        view = RoleChoiceView(trade_id, interaction.user.id, other_user.id)

        # Ticket welcome message
        await channel.send(
            f"**Trade #{trade_id} started**\n"
            f"**Currency:** {self.currency}\n"
            f"**Escrow deposit address:** `{deposit_addr}`\n"
            f"**{interaction.user.mention}** is giving: {you_give}\n"
            f"**{other_user.mention}** should give: {they_give}\n\n"
            f"**{other_user.mention}**, choose your role:\n"
            f"- **Sender** = you send first (deposit to escrow)\n"
            f"- **Receiver** = you receive after confirmation",
            view=view
        )

        await interaction.response.send_message(
            f"Private ticket created: {channel.mention}\n"
            f"Other party: {other_user.mention}\n"
            f"Waiting for role selection...",
            ephemeral=True
        )

# ────────────────────────────────────────────────
# Sender / Receiver buttons
# ────────────────────────────────────────────────
class RoleChoiceView(View):
    def __init__(self, trade_id: int, starter_id: int, other_id: int):
        super().__init__(timeout=86400)  # 24 hours
        self.trade_id = trade_id
        self.starter_id = starter_id
        self.other_id = other_id

    @discord.ui.button(label="Sender", style=discord.ButtonStyle.green, emoji="📤")
    async def sender_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.other_id:
            return await interaction.response.send_message("This is for the other party only.", ephemeral=True)

        c.execute("UPDATE trades SET status = 'sender_chosen' WHERE id = ?", (self.trade_id,))
        conn.commit()

        await interaction.response.send_message(
            f"{interaction.user.mention} chose **Sender**.\n"
            "Next: Sender deposits → escrow holds → confirmation → release.",
            ephemeral=False
        )
        self.stop()

    @discord.ui.button(label="Receiver", style=discord.ButtonStyle.blurple, emoji="📥")
    async def receiver_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.other_id:
            return await interaction.response.send_message("This is for the other party only.", ephemeral=True)

        c.execute("UPDATE trades SET status = 'receiver_chosen' WHERE id = ?", (self.trade_id,))
        conn.commit()

        await interaction.response.send_message(
            f"{interaction.user.mention} chose **Receiver**.\n"
            "Next: Sender deposits → escrow holds → confirmation → release.",
            ephemeral=False
        )
        self.stop()

# ────────────────────────────────────────────────
# Crypto selection panel
# ────────────────────────────────────────────────
class CryptoSelectView(View):
    def __init__(self):
        super().__init__(timeout=None)

        options = [
            SelectOption(label="Bitcoin", emoji="🟠", value="BTC"),
            SelectOption(label="Ethereum", emoji="💎", value="ETH"),
            SelectOption(label="Litecoin", emoji="🔷", value="LTC"),
            SelectOption(label="Solana", emoji="☀️", value="SOL"),
            SelectOption(label="USDT [ERC-20]", emoji="💵", value="USDT_ERC20"),
            SelectOption(label="USDC [ERC-20]", emoji="💵", value="USDC_ERC20"),
            SelectOption(label="USDT [SOL]", emoji="💵", value="USDT_SOL"),
            SelectOption(label="USDC [SOL]", emoji="💵", value="USDC_SOL"),
            SelectOption(label="USDT [BEP-20]", emoji="💵", value="USDT_BEP20"),
        ]

        select = Select(
            placeholder="Make a selection",
            min_values=1,
            max_values=1,
            options=options,
            custom_id="crypto_select_menu"
        )

        @select.callback
        async def callback(interaction: discord.Interaction):
            currency = interaction.data['values'][0]
            modal = TradeDetailsModal(currency=currency)
            await interaction.response.send_modal(modal)

        self.add_item(select)

# ────────────────────────────────────────────────
# Bot events & commands
# ────────────────────────────────────────────────
@client.event
async def on_ready():
    client.add_view(CryptoSelectView())
    await tree.sync()
    print(f'Logged in as {client.user} | Ready')

@tree.command(name="autoticketpanel", description="Open crypto trade panel")
async def auto_ticket_panel(interaction: discord.Interaction):
    c.execute("SELECT * FROM activated_users WHERE user_id=?", (str(interaction.user.id),))
    if not c.fetchone():
        return await interaction.response.send_message("Redeem a key first.", ephemeral=True)

    embed = discord.Embed(
        title="Crypto Currency",
        description=(
            "**Fees:**\n"
            "• Deals over 250$: **2$**\n"
            "• Deals under 250$: **1$**\n"
            "• Deals under 50$: **0.7$**\n"
            "• Deals under 10$: **0.3$**\n"
            "• Deals under 5$: **FREE**"
        ),
        color=discord.Color.blue()
    )
    embed.set_footer(text="Select cryptocurrency to start trade")

    await interaction.response.send_message(embed=embed, view=CryptoSelectView())

# Other commands (generatekey, redeemkey) - keep as before
# ... paste your existing generatekey and redeemkey commands here ...

# Background monitoring placeholder
async def monitor_deposits():
    await client.wait_until_ready()
    while not client.is_closed():
        # TODO: real monitoring
        await asyncio.sleep(90)

# Async setup hook
async def setup_hook():
    client.loop.create_task(monitor_deposits())

client.setup_hook = setup_hook

client.run(TOKEN)
