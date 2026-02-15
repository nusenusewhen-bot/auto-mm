import discord
from discord import app_commands, SelectOption
from discord.ui import View, Select
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
import time
from bitcoinlib.wallets import Wallet, wallet_exists, WalletError  # ← added wallet_exists

# ────────────────────────────────────────────────
# Env loading
# ────────────────────────────────────────────────
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
MNEMONIC = os.getenv('BOT_MNEMONIC')

if not TOKEN:
    print("DISCORD_TOKEN missing")
    exit(1)

# ────────────────────────────────────────────────
# Litecoin wallet – safe create-or-open
# ────────────────────────────────────────────────
wallet = None
if MNEMONIC:
    WALLET_NAME = "AutoMMBotWallet"
    try:
        if wallet_exists(WALLET_NAME):
            wallet = Wallet(WALLET_NAME)  # open existing
            print(f"Opened existing wallet '{WALLET_NAME}'")
        else:
            wallet = Wallet.create(
                name=WALLET_NAME,
                keys=MNEMONIC,
                network='litecoin',
                witness_type='segwit'
            )
            print(f"Created new wallet '{WALLET_NAME}'")

        # Verify
        key0 = wallet.key_for_path("m/44'/2'/0'/0/0")
        print(f"Bot personal LTC address #0: {key0.address}")
    except WalletError as e:
        print(f"Wallet error: {e}")
        print("Fix: Check mnemonic spelling/spacing in Railway vars, or delete old DB if testing")
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
# Bot
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
        select = Select(placeholder="Make a selection", options=options, custom_id="crypto_select_menu")

        @select.callback
        async def callback(interaction: discord.Interaction):
            currency = interaction.data['values'][0]
            trade_index = int(time.time() * 1000) % 1000000
            addr = get_deposit_address(trade_index)

            c.execute(
                "INSERT INTO trades (buyer_id, currency, deposit_addr, channel_id, status) VALUES (?, ?, ?, ?, ?)",
                (str(interaction.user.id), currency, addr, str(interaction.channel_id), 'waiting_deposit')
            )
            conn.commit()

            await interaction.response.send_message(
                f"Trade started ({currency})\nDeposit: `{addr}`\nBot monitors automatically.",
                ephemeral=True
            )

        self.add_item(select)

@client.event
async def on_ready():
    client.add_view(CryptoSelectView())
    await tree.sync()
    print(f'Logged in as {client.user} | Ready for middleman trades')

# ────────────────────────────────────────────────
# Commands
# ────────────────────────────────────────────────
@tree.command(name="generatekey", description="Generate activation key (owner only)")
async def generate_key(interaction: discord.Interaction):
    if interaction.user.id != OWNER_ID:
        return await interaction.response.send_message("Unauthorized.", ephemeral=True)
    key = os.urandom(8).hex().upper()
    c.execute("INSERT INTO keys (key) VALUES (?)", (key,))
    conn.commit()
    await interaction.response.send_message(f"New key: `{key}`\nUse /redeemkey", ephemeral=True)

@tree.command(name="redeemkey", description="Redeem key")
@app_commands.describe(key="Key")
async def redeem_key(interaction: discord.Interaction, key: str):
    c.execute("SELECT used FROM keys WHERE key=?", (key.upper(),))
    row = c.fetchone()
    if not row or row[0] == 1:
        return await interaction.response.send_message("Invalid/used key.", ephemeral=True)
    c.execute("UPDATE keys SET used=1 WHERE key=?", (key.upper(),))
    c.execute("INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)", (str(interaction.user.id),))
    conn.commit()
    await interaction.response.send_message("Activated! → /autoticketpanel", ephemeral=True)

@tree.command(name="autoticketpanel", description="Open crypto trade panel")
async def auto_ticket_panel(interaction: discord.Interaction):
    c.execute("SELECT * FROM activated_users WHERE user_id=?", (str(interaction.user.id),))
    if not c.fetchone():
        return await interaction.response.send_message("Redeem a key first.", ephemeral=True)

    embed = discord.Embed(
        title="Crypto Currency",
        description="**Fees:**\n• >250$: 2$\n• <250$: 1$\n• <50$: 0.7$\n• <10$: 0.3$\n• <5$: FREE",
        color=discord.Color.blue()
    )
    await interaction.response.send_message(embed=embed, view=CryptoSelectView())

# ────────────────────────────────────────────────
# Async init hook – fixes loop access error
# ────────────────────────────────────────────────
async def setup_hook():
    # Start background monitoring here (loop exists now)
    client.loop.create_task(monitor_deposits())

# Attach the hook
client.setup_hook = setup_hook

# ────────────────────────────────────────────────
# Background monitoring (expand with real API calls)
# ────────────────────────────────────────────────
async def monitor_deposits():
    await client.wait_until_ready()  # safe to access channels/DB here
    while not client.is_closed():
        try:
            c.execute("SELECT id, deposit_addr, currency FROM trades WHERE status = 'waiting_deposit'")
            for row in c.fetchall():
                trade_id, addr, currency = row
                print(f"[Monitor] Trade #{trade_id} | {currency} @ {addr} → checking balance...")
                # TODO: Add real check, e.g. requests.get('https://chain.so/api/v2/get_address_balance/LTC/' + addr)
                # if received >= expected: update status, notify
        except Exception as e:
            print(f"Monitor error: {e}")
        await asyncio.sleep(90)  # 1.5 min

# ────────────────────────────────────────────────
# Run bot
# ────────────────────────────────────────────────
client.run(TOKEN)
