import discord
from discord import app_commands
from discord.ui import View, Select, SelectOption
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
from bitcoinlib.wallets import HDWallet, WalletError

# ────────────────────────────────────────────────
# Load environment (Railway + local fallback)
# ────────────────────────────────────────────────
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
MNEMONIC = os.getenv('BOT_MNEMONIC')

if not TOKEN:
    print("DISCORD_TOKEN missing")
    exit(1)
if not MNEMONIC:
    print("BOT_MNEMONIC missing - wallet will NOT work")
    # You can continue without wallet, but escrow features will fail

# ────────────────────────────────────────────────
# Litecoin wallet setup
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
        # Optional: log first address for verification
        print("Bot LTC address #0:", wallet.key_for_path("m/44'/2'/0'/0/0").address)
    except WalletError as e:
        print(f"Wallet error: {e}")
        print("Check mnemonic in Railway variables (typo/spacing/checksum)")

# Function to get unique deposit address per trade
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

OWNER_ID = 1298640383688970293  # change if needed

class CryptoSelectView(View):
    def __init__(self):
        super().__init__(timeout=None)

        options = [
            SelectOption(label="Litecoin", emoji="🔷", value="LTC", default=True),
            SelectOption(label="Bitcoin", emoji="🟠", value="BTC"),
            SelectOption(label="Solana", emoji="☀️", value="SOL"),
            # add more as needed
        ]

        select = Select(
            placeholder="Make a selection",
            options=options,
            custom_id="crypto_select"
        )

        @select.callback
        async def callback(interaction: discord.Interaction):
            currency = interaction.data['values'][0]
            # Placeholder: in real version create private channel, ask amount/seller, etc.
            addr = get_deposit_address(int(asyncio.get_event_loop().time() % 1000000))  # simple unique-ish
            await interaction.response.send_message(
                f"Selected **{currency}**\nSend funds to: `{addr}`\n(bot will monitor)",
                ephemeral=True
            )

        self.add_item(select)

@client.event
async def on_ready():
    client.add_view(CryptoSelectView())
    await tree.sync()
    print(f'Logged in as {client.user}')

# ────────────────────────────────────────────────
# Commands
# ────────────────────────────────────────────────

@tree.command(name="generatekey", description="Generate activation key (owner only)")
async def generate_key(interaction: discord.Interaction):
    if interaction.user.id != OWNER_ID:
        await interaction.response.send_message("Not authorized.", ephemeral=True)
        return
    key = os.urandom(8).hex().upper()
    c.execute("INSERT INTO keys (key) VALUES (?)", (key,))
    conn.commit()
    await interaction.response.send_message(f"Key: `{key}`", ephemeral=True)

@tree.command(name="redeemkey", description="Redeem activation key")
@app_commands.describe(key="Key to redeem")
async def redeem_key(interaction: discord.Interaction, key: str):
    c.execute("SELECT used FROM keys WHERE key=?", (key.upper(),))
    row = c.fetchone()
    if not row:
        await interaction.response.send_message("Invalid key.", ephemeral=True)
        return
    if row[0]:
        await interaction.response.send_message("Already used.", ephemeral=True)
        return
    c.execute("UPDATE keys SET used=1 WHERE key=?", (key.upper(),))
    c.execute("INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)", (str(interaction.user.id),))
    conn.commit()
    await interaction.response.send_message("Activated! Use /autoticketpanel", ephemeral=True)

@tree.command(name="autoticketpanel", description="Send crypto ticket panel")
async def auto_ticket_panel(interaction: discord.Interaction):
    c.execute("SELECT * FROM activated_users WHERE user_id=?", (str(interaction.user.id),))
    if not c.fetchone():
        await interaction.response.send_message("Activate with a key first.", ephemeral=True)
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

    await interaction.response.send_message(embed=embed, view=CryptoSelectView())

# Background monitoring task (placeholder - expand with real API later)
async def monitor_deposits():
    while True:
        # TODO: query trades with status='waiting_deposit'
        # TODO: check balance via chain.so or blockcypher API
        await asyncio.sleep(60)

client.loop.create_task(monitor_deposits())

client.run(TOKEN)
