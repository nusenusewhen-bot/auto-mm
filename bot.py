import discord
from discord import app_commands, SelectOption
from discord.ui import View, Select
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
import time  # for unique index fallback
from bitcoinlib.wallets import Wallet, WalletError   # Correct import for modern bitcoinlib
from bitcoinlib.keys import HDKey  # for manual fallback if needed

# ────────────────────────────────────────────────
# Load environment variables (Railway)
# ────────────────────────────────────────────────
load_dotenv()  # fallback for local testing only

TOKEN = os.getenv('DISCORD_TOKEN')
MNEMONIC = os.getenv('BOT_MNEMONIC')

if not TOKEN:
    print("CRITICAL: DISCORD_TOKEN not found in environment variables")
    exit(1)

# ────────────────────────────────────────────────
# Bot-controlled Litecoin wallet (HD from mnemonic)
# ────────────────────────────────────────────────
wallet = None
if MNEMONIC:
    try:
        wallet = Wallet.create(
            name="AutoMMBotWallet",
            keys=MNEMONIC,
            network='litecoin',
            witness_type='segwit',  # ltc1... addresses
            # db_uri='sqlite:///bot_wallet.db'  # optional separate DB
        )
        print("SUCCESS: Litecoin wallet loaded from mnemonic")
        # Log first address for verification
        key0 = wallet.key_for_path("m/44'/2'/0'/0/0")
        print(f"Bot personal LTC address #0: {key0.address}")
    except WalletError as e:
        print(f"Wallet loading failed: {str(e)}")
        print("Check BOT_MNEMONIC in Railway Variables (exact words, single spaces, no quotes)")
else:
    print("WARNING: BOT_MNEMONIC not set → wallet features disabled")

def get_deposit_address(trade_index: int):
    """Generate unique SegWit Litecoin deposit address for a trade."""
    if not wallet:
        return "WALLET_NOT_LOADED_ERROR"
    try:
        key = wallet.key_for_path(f"m/44'/2'/0'/0/{trade_index}")
        return key.address
    except Exception as e:
        print(f"Address generation error: {e}")
        return "ADDRESS_GEN_FAILED"

# ────────────────────────────────────────────────
# SQLite database for keys, users & trades
# ────────────────────────────────────────────────
conn = sqlite3.connect('trades.db')
c = conn.cursor()

# Activation keys
c.execute('''CREATE TABLE IF NOT EXISTS keys
             (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)''')

# Activated users
c.execute('''CREATE TABLE IF NOT EXISTS activated_users
             (user_id TEXT PRIMARY KEY)''')

# Trades (escrow records)
c.execute('''CREATE TABLE IF NOT EXISTS trades
             (id INTEGER PRIMARY KEY AUTOINCREMENT,
              buyer_id TEXT NOT NULL,
              seller_id TEXT,               -- can be added later
              amount REAL,
              currency TEXT NOT NULL,
              deposit_addr TEXT NOT NULL,
              status TEXT DEFAULT 'waiting_deposit',
              channel_id TEXT,
              created_at INTEGER DEFAULT (strftime('%s', 'now')))''')
conn.commit()

# ────────────────────────────────────────────────
# Discord bot setup
# ────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

OWNER_ID = 1298640383688970293  # your Discord ID

# Persistent view for crypto selection panel
class CryptoSelectView(View):
    def __init__(self):
        super().__init__(timeout=None)  # persistent

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
            currency = interaction.data['values'][0]
            # Simple unique index (timestamp-based)
            trade_index = int(time.time() * 1000) % 1000000
            addr = get_deposit_address(trade_index)

            # Save trade record (expand later with amount/seller)
            c.execute(
                """INSERT INTO trades (buyer_id, currency, deposit_addr, channel_id, status)
                   VALUES (?, ?, ?, ?, ?)""",
                (str(interaction.user.id), currency, addr, str(interaction.channel_id), 'waiting_deposit')
            )
            conn.commit()

            await interaction.response.send_message(
                f"**Trade started** | Currency: **{currency}**\n"
                f"Deposit address: `{addr}`\n"
                f"Send the agreed amount. Bot will detect incoming tx (monitoring placeholder).",
                ephemeral=True
            )

        self.add_item(select)

@client.event
async def on_ready():
    client.add_view(CryptoSelectView())  # make panel persistent
    await tree.sync()
    print(f'Bot logged in as {client.user} | Ready')

# ────────────────────────────────────────────────
# Slash commands
# ────────────────────────────────────────────────

@tree.command(name="generatekey", description="Generate new activation key (Owner only)")
async def generate_key(interaction: discord.Interaction):
    if interaction.user.id != OWNER_ID:
        await interaction.response.send_message("Unauthorized.", ephemeral=True)
        return

    key = os.urandom(8).hex().upper()
    c.execute("INSERT INTO keys (key) VALUES (?)", (key,))
    conn.commit()
    await interaction.response.send_message(f"New key: `{key}`\nRedeem with `/redeemkey {key}`", ephemeral=True)

@tree.command(name="redeemkey", description="Redeem an activation key")
@app_commands.describe(key="The activation key")
async def redeem_key(interaction: discord.Interaction, key: str):
    c.execute("SELECT used FROM keys WHERE key=?", (key.upper(),))
    row = c.fetchone()
    if not row:
        await interaction.response.send_message("Invalid key.", ephemeral=True)
        return
    if row[0] == 1:
        await interaction.response.send_message("This key is already used.", ephemeral=True)
        return

    c.execute("UPDATE keys SET used=1 WHERE key=?", (key.upper(),))
    c.execute("INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)", (str(interaction.user.id),))
    conn.commit()

    await interaction.response.send_message(
        "Key redeemed successfully!\nYou can now use `/autoticketpanel` to open the trade panel.",
        ephemeral=True
    )

@tree.command(name="autoticketpanel", description="Create the crypto trade ticket panel")
async def auto_ticket_panel(interaction: discord.Interaction):
    c.execute("SELECT * FROM activated_users WHERE user_id=?", (str(interaction.user.id),))
    if not c.fetchone():
        await interaction.response.send_message("You must redeem a key first to use this.", ephemeral=True)
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
    embed.set_footer(text="Select cryptocurrency to start a middleman trade")

    view = CryptoSelectView()
    await interaction.response.send_message(embed=embed, view=view)

# ────────────────────────────────────────────────
# Background task: monitor deposits (placeholder – expand with real API)
# ────────────────────────────────────────────────
async def monitor_deposits():
    while True:
        try:
            c.execute("SELECT id, deposit_addr, currency, amount FROM trades WHERE status = 'waiting_deposit'")
            for row in c.fetchall():
                trade_id, addr, currency, expected = row
                # TODO: replace with real API call (e.g. chain.so, blockcypher, mempool.space)
                # Example placeholder
                print(f"Checking trade {trade_id} | {currency} addr: {addr} | expected: {expected}")
                # if balance >= expected: update status to 'deposited', notify channel
        except Exception as e:
            print(f"Monitor error: {e}")
        await asyncio.sleep(90)  # check every ~1.5 min

# Start monitoring loop
client.loop.create_task(monitor_deposits())

client.run(TOKEN)
