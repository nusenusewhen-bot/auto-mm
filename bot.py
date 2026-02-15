import discord
from discord import app_commands, SelectOption
from discord.ui import View, Select, Modal, TextInput, Button
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
import time
from bitcoinlib.wallets import Wallet, wallet_exists, WalletError

# ────────────────────────────────────────────────
# Env
# ────────────────────────────────────────────────
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
MNEMONIC = os.getenv('BOT_MNEMONIC')

if not TOKEN:
    print("DISCORD_TOKEN missing")
    exit(1)

# ────────────────────────────────────────────────
# Wallet (safe open/create)
# ────────────────────────────────────────────────
wallet = None
if MNEMONIC:
    WALLET_NAME = "AutoMMBotWallet"
    try:
        if wallet_exists(WALLET_NAME):
            wallet = Wallet(WALLET_NAME)
            print(f"Opened existing wallet: {WALLET_NAME}")
        else:
            wallet = Wallet.create(
                name=WALLET_NAME,
                keys=MNEMONIC,
                network='litecoin',
                witness_type='segwit'
            )
            print(f"Created new wallet: {WALLET_NAME}")
        key0 = wallet.key_for_path("m/44'/2'/0'/0/0")
        print(f"Bot LTC address #0: {key0.address}")
    except WalletError as e:
        print(f"Wallet error: {e}")

def get_deposit_address(index: int):
    if not wallet:
        return "WALLET_NOT_LOADED"
    return wallet.key_for_path(f"m/44'/2'/0'/0/{index}").address

# ────────────────────────────────────────────────
# Database
# ────────────────────────────────────────────────
conn = sqlite3.connect('trades.db')
c = conn.cursor()
c.execute('''CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)''')
c.execute('''CREATE TABLE IF NOT EXISTS activated_users (user_id TEXT PRIMARY KEY)''')
c.execute('''CREATE TABLE IF NOT EXISTS trades
             (id INTEGER PRIMARY KEY AUTOINCREMENT,
              buyer_id TEXT,
              currency TEXT,
              deposit_addr TEXT,
              channel_id TEXT,
              status TEXT DEFAULT 'waiting_role')''')
conn.commit()

# ────────────────────────────────────────────────
# Bot
# ────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

OWNER_ID = 1298640383688970293

# ────────────────────────────────────────────────
# Modal
# ────────────────────────────────────────────────
class TradeDetailsModal(Modal, title="Trade Setup"):
    other_user = TextInput(
        label="User/ID of the other person",
        placeholder="@username or ID",
        required=True,
        max_length=100
    )
    you_give = TextInput(
        label="What are YOU giving",
        style=discord.TextStyle.paragraph,
        required=True,
        max_length=500
    )
    they_give = TextInput(
        label="What are THEY giving",
        style=discord.TextStyle.paragraph,
        required=True,
        max_length=500
    )

    def __init__(self, currency: str):
        super().__init__()
        self.currency = currency

    async def on_submit(self, interaction: discord.Interaction):
        other_input = self.other_user.value.strip()
        you = self.you_give.value.strip()
        they = self.they_give.value.strip()

        other_user = None
        if other_input.startswith('<@') and other_input.endswith('>'):
            try:
                uid = int(other_input[2:-1].replace('!', ''))
                other_user = await client.fetch_user(uid)
            except:
                pass
        else:
            try:
                other_user = await client.fetch_user(int(other_input))
            except:
                pass

        if not other_user:
            return await interaction.response.send_message("Invalid user ID/mention.", ephemeral=True)

        if other_user.id == interaction.user.id:
            return await interaction.response.send_message("Can't trade with yourself.", ephemeral=True)

        idx = int(time.time() * 1000) % 1000000
        addr = get_deposit_address(idx)

        c.execute(
            "INSERT INTO trades (buyer_id, currency, deposit_addr, channel_id, status) VALUES (?, ?, ?, ?, ?)",
            (str(interaction.user.id), self.currency, addr, "pending", 'waiting_role')
        )
        trade_id = c.lastrowid
        conn.commit()

        guild = interaction.guild
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            interaction.user: discord.PermissionOverwrite(view_channel=True, send_messages=True),
            other_user: discord.PermissionOverwrite(view_channel=True, send_messages=True),
        }

        channel = await guild.create_text_channel(
            f"trade-{trade_id}",
            overwrites=overwrites,
            topic=f"Trade #{trade_id} | {self.currency}"
        )

        c.execute("UPDATE trades SET channel_id = ? WHERE id = ?", (channel.id, trade_id))
        conn.commit()

        view = RoleChoiceView(trade_id, interaction.user.id, other_user.id)

        await channel.send(
            f"**Trade #{trade_id}**\n"
            f"Currency: **{self.currency}**\n"
            f"Escrow deposit: `{addr}`\n"
            f"{interaction.user.mention} gives: {you}\n"
            f"{other_user.mention} gives: {they}\n\n"
            f"{other_user.mention}, choose role:",
            view=view
        )

        await interaction.response.send_message(f"Ticket: {channel.mention}", ephemeral=True)

# ────────────────────────────────────────────────
# Role buttons
# ────────────────────────────────────────────────
class RoleChoiceView(View):
    def __init__(self, trade_id, starter_id, other_id):
        super().__init__(timeout=86400)
        self.trade_id = trade_id
        self.starter_id = starter_id
        self.other_id = other_id

    @discord.ui.button(label="Sender", style=discord.ButtonStyle.green)
    async def sender(self, interaction: discord.Interaction, _):
        if interaction.user.id != self.other_id:
            return await interaction.response.send_message("Not for you.", ephemeral=True)
        c.execute("UPDATE trades SET status = 'sender' WHERE id = ?", (self.trade_id,))
        conn.commit()
        await interaction.response.send_message(f"{interaction.user.mention} is Sender", ephemeral=False)
        self.stop()

    @discord.ui.button(label="Receiver", style=discord.ButtonStyle.blurple)
    async def receiver(self, interaction: discord.Interaction, _):
        if interaction.user.id != self.other_id:
            return await interaction.response.send_message("Not for you.", ephemeral=True)
        c.execute("UPDATE trades SET status = 'receiver' WHERE id = ?", (self.trade_id,))
        conn.commit()
        await interaction.response.send_message(f"{interaction.user.mention} is Receiver", ephemeral=False)
        self.stop()

# ────────────────────────────────────────────────
# Panel
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
        select = Select(placeholder="Make a selection", options=options)

        @select.callback
        async def cb(interaction: discord.Interaction):
            await interaction.response.send_modal(TradeDetailsModal(interaction.data['values'][0]))

        self.add_item(select)

# ────────────────────────────────────────────────
# Commands
# ────────────────────────────────────────────────
@tree.command(name="generatekey", description="Generate key (owner only)")
async def gen_key(interaction: discord.Interaction):
    if interaction.user.id != OWNER_ID:
        return await interaction.response.send_message("No.", ephemeral=True)
    key = os.urandom(8).hex().upper()
    c.execute("INSERT INTO keys (key) VALUES (?)", (key,))
    conn.commit()
    await interaction.response.send_message(f"Key: `{key}`", ephemeral=True)

@tree.command(name="redeemkey", description="Redeem key")
@app_commands.describe(key="Key")
async def redeem(interaction: discord.Interaction, key: str):
    c.execute("SELECT used FROM keys WHERE key=?", (key.upper(),))
    r = c.fetchone()
    if not r or r[0]:
        return await interaction.response.send_message("Invalid/used.", ephemeral=True)
    c.execute("UPDATE keys SET used=1 WHERE key=?", (key.upper(),))
    c.execute("INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)", (str(interaction.user.id),))
    conn.commit()
    await interaction.response.send_message("Activated.", ephemeral=True)

@tree.command(name="autoticketpanel", description="Open panel")
async def panel(interaction: discord.Interaction):
    c.execute("SELECT * FROM activated_users WHERE user_id=?", (str(interaction.user.id),))
    if not c.fetchone():
        return await interaction.response.send_message("Activate first.", ephemeral=True)
    embed = discord.Embed(title="Crypto Currency", description="**Fees:**\n• >250$: 2$\n• <250$: 1$\n• <50$: 0.7$\n• <10$: 0.3$\n• <5$: FREE")
    await interaction.response.send_message(embed=embed, view=CryptoSelectView())

# ────────────────────────────────────────────────
# Events
# ────────────────────────────────────────────────
@client.event
async def on_ready():
    print(f'Logged in: {client.user}')
    try:
        synced = await tree.sync()
        print(f"Synced {len(synced)} commands:")
        for cmd in synced:
            print(f" - /{cmd.name}")
    except Exception as e:
        print(f"Sync failed: {e}")
    client.add_view(CryptoSelectView())

async def setup_hook():
    client.loop.create_task(monitor())

client.setup_hook = setup_hook

async def monitor():
    await client.wait_until_ready()
    while not client.is_closed():
        await asyncio.sleep(90)

client.run(TOKEN)
