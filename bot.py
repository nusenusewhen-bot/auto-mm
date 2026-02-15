import discord
from discord import app_commands, SelectOption   # ← SelectOption comes from here now
from discord.ui import View, Select
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
from bitcoinlib.wallets import HDWallet, WalletError

# ────────────────────────────────────────────────
# Environment variables (Railway)
# ────────────────────────────────────────────────
load_dotenv()  # only needed for local testing
TOKEN = os.getenv('DISCORD_TOKEN')
MNEMONIC = os.getenv('BOT_MNEMONIC')

if not TOKEN:
    print("DISCORD_TOKEN missing")
    exit(1)

# ────────────────────────────────────────────────
# Litecoin wallet
# ────────────────────────────────────────────────
wallet = None
if MNEMONIC:
    try:
        wallet = HDWallet.create(
            name="BotLTCWallet",
            keys=MNEMONIC,
            network='litecoin',
            witness_type='segwit'
        )
        print("Litecoin wallet loaded successfully")
        print("Bot LTC address #0:", wallet.key_for_path("m/44'/2'/0'/0/0").address)
    except WalletError as e:
        print(f"Wallet error: {e}")

def get_deposit_address(trade_index: int):
    if not wallet:
        return "WALLET_NOT_LOADED"
    key = wallet.key_for_path(f"m/44'/2'/0'/0/{trade_index}")
    return key.address

# ────────────────────────────────────────────────
# Database (SQLite)
# ────────────────────────────────────────────────
conn = sqlite3.connect('trades.db')  # Railway volume recommended for persistence
c = conn.cursor()
c.execute('''CREATE TABLE IF NOT EXISTS keys
             (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)''')
c.execute('''CREATE TABLE IF NOT EXISTS activated_users
             (user_id TEXT PRIMARY KEY)''')
c.execute('''CREATE TABLE IF NOT EXISTS trades
             (id INTEGER PRIMARY KEY AUTOINCREMENT,
              buyer_id TEXT,
              amount REAL,
              currency TEXT,
              deposit_addr TEXT,
              status TEXT DEFAULT 'waiting_deposit',
              channel_id TEXT)''')
conn.commit()

# ────────────────────────────────────────────────
# Discord bot
# ────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

OWNER_ID = 1298640383688970293

class CryptoSelectView(View):
    def __init__(self):
        super().__init__(timeout=None)

        options = [
            SelectOption(label="Bitcoin", emoji="🟠", value="BTC"),
            SelectOption(label="Ethereum", emoji="💎", value="ETH"),
            SelectOption(label="Litecoin", emoji="🔷", value="LTC", default=True),
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
            selected = interaction.data['values'][0]
            # Simple placeholder — expand to create channel, save trade, etc.
            addr = get_deposit_address(int(asyncio.get_event_loop().time() % 1000000))
            await interaction.response.send_message(
                f"You selected **{selected}**\nDeposit address: `{addr}`\nWaiting for funds...",
                ephemeral=True
            )

        self.add_item(select)

@client.event
async def on_ready():
    client.add_view(CryptoSelectView())
    await tree.sync()
    print(f'Logged in as {client.user}')

# Commands
@tree.command(name="generatekey", description="Generate new activation key (Owner only)")
async def generate_key(interaction: discord.Interaction):
    if interaction.user.id != OWNER_ID:
        await interaction.response.send_message("Not authorized.", ephemeral=True)
        return

    key = os.urandom(8).hex().upper()
    c.execute("INSERT INTO keys (key) VALUES (?)", (key,))
    conn.commit()
    await interaction.response.send_message(f"New key: `{key}`\nRedeem with /redeemkey", ephemeral=True)

@tree.command(name="redeemkey", description="Redeem activation key")
@app_commands.describe(key="The key")
async def redeem_key(interaction: discord.Interaction, key: str):
    c.execute("SELECT used FROM keys WHERE key=?", (key.upper(),))
    row = c.fetchone()
    if not row:
        await interaction.response.send_message("Invalid key.", ephemeral=True)
        return
    if row[0] == 1:
        await interaction.response.send_message("Key already used.", ephemeral=True)
        return

    c.execute("UPDATE keys SET used=1 WHERE key=?", (key.upper(),))
    c.execute("INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)", (str(interaction.user.id),))
    conn.commit()
    await interaction.response.send_message("Activated! Use /autoticketpanel", ephemeral=True)

@tree.command(name="autoticketpanel", description="Send crypto ticket panel")
async def auto_ticket_panel(interaction: discord.Interaction):
    c.execute("SELECT * FROM activated_users WHERE user_id=?", (str(interaction.user.id),))
    if not c.fetchone():
        await interaction.response.send_message("Activate with key first.", ephemeral=True)
        return

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

    view = CryptoSelectView()
    await interaction.response.send_message(embed=embed, view=view)

client.run(TOKEN)
