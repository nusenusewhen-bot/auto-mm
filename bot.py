import discord
from discord import app_commands
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
from bitcoinlib.wallets import Wallet, wallet_exists, WalletError
from views import PanelView, TradeModal, RoleView  # Import from views.py

load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
MNEMONIC = os.getenv('BOT_MNEMONIC')

if not TOKEN:
    print("DISCORD_TOKEN missing")
    exit(1)

OWNER_ID = 1298640383688970293

# Wallet
wallet = None
if MNEMONIC:
    name = "AutoMMBotWallet"
    try:
        if wallet_exists(name):
            wallet = Wallet(name)
            print(f"Opened wallet: {name}")
        else:
            wallet = Wallet.create(name=name, keys=MNEMONIC, network='litecoin', witness_type='segwit')
            print(f"Created wallet: {name}")
        print("LTC #0:", wallet.key_for_path("m/44'/2'/0'/0/0").address)
    except Exception as e:
        print(f"Wallet error: {e}")

def get_addr(idx):
    return wallet.key_for_path(f"m/44'/2'/0'/0/{idx}").address if wallet else "NO_WALLET"

# Database
conn = sqlite3.connect('trades.db')
c = conn.cursor()
c.execute('CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)')
c.execute('CREATE TABLE IF NOT EXISTS activated_users (user_id TEXT PRIMARY KEY)')
c.execute('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, buyer_id TEXT, currency TEXT, deposit_addr TEXT, channel_id TEXT, status TEXT DEFAULT "waiting_role")')
conn.commit()

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

@client.event
async def on_ready():
    print(f'Logged in: {client.user} (ID: {client.user.id})')

    # Guild sync for instant command appearance (CHANGE YOUR_GUILD_ID)
    YOUR_GUILD_ID = 123456789012345678  # ← REPLACE WITH YOUR SERVER ID
    guild = client.get_guild(YOUR_GUILD_ID)
    if guild:
        try:
            await tree.sync(guild=guild)
            print(f"Commands synced to guild: {guild.name}")
        except Exception as e:
            print(f"Guild sync failed: {e}")

    # Global sync
    try:
        synced = await tree.sync()
        print(f"Global sync: {len(synced)} commands")
        for s in synced:
            print(f" - /{s.name}")
    except Exception as e:
        print(f"Global sync failed: {e}")

    # Register persistent views
    client.add_view(PanelView())

@tree.command(name="generatekey", description="Generate key (owner only)")
async def gk(i: discord.Interaction):
    if i.user.id != OWNER_ID:
        return await i.response.send_message("No.", ephemeral=True)
    k = os.urandom(8).hex().upper()
    c.execute("INSERT INTO keys (key) VALUES (?)", (k,))
    conn.commit()
    await i.response.send_message(f"Key: `{k}`", ephemeral=True)

@tree.command(name="redeemkey", description="Redeem key")
@app_commands.describe(key="Key")
async def rk(i: discord.Interaction, key: str):
    if i.user.id == OWNER_ID:
        return await i.response.send_message("Owner doesn't need key.", ephemeral=True)
    c.execute("SELECT used FROM keys WHERE key=?", (key.upper(),))
    r = c.fetchone()
    if not r or r[0]:
        return await i.response.send_message("Invalid/used.", ephemeral=True)
    c.execute("UPDATE keys SET used=1 WHERE key=?", (key.upper(),))
    c.execute("INSERT OR IGNORE INTO activated_users (user_id) VALUES (?)", (str(i.user.id),))
    conn.commit()
    await i.response.send_message("Activated.", ephemeral=True)

@tree.command(name="autoticketpanel", description="Open trade panel")
async def tp(i: discord.Interaction):
    # Owner bypasses activation check
    if i.user.id != OWNER_ID:
        c.execute("SELECT 1 FROM activated_users WHERE user_id=?", (str(i.user.id),))
        if not c.fetchone():
            return await i.response.send_message("Redeem a key first.", ephemeral=True)

    e = discord.Embed(
        title="Crypto Currency",
        description="**Fees:**\n• >250$: 2$\n• <250$: 1$\n• <50$: 0.7$\n• <10$: 0.3$\n• <5$: FREE"
    )
    await i.response.send_message(embed=e, view=PanelView())

async def setup_hook():
    client.loop.create_task(monitor())

client.setup_hook = setup_hook

async def monitor():
    await client.wait_until_ready()
    while not client.is_closed():
        await asyncio.sleep(60)

client.run(TOKEN)
