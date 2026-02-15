import discord
from discord import app_commands, SelectOption
from discord.ui import View, Select, Modal, TextInput, Button
import os
import sqlite3
import asyncio
from dotenv import load_dotenv
import time
from bitcoinlib.wallets import Wallet, wallet_exists, WalletError

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

# Modal
class TradeModal(Modal, title="Trade Setup"):
    other = TextInput(label="User/ID of the other person", placeholder="@mention or ID", required=True)
    you_give = TextInput(label="What are YOU giving", style=discord.TextStyle.paragraph, required=True)
    they_give = TextInput(label="What are THEY giving", style=discord.TextStyle.paragraph, required=True)

    def __init__(self, currency):
        super().__init__()
        self.currency = currency

    async def on_submit(self, i: discord.Interaction):
        await i.response.defer(ephemeral=True)

        other_input = self.other.value.strip()
        u = None
        if other_input.startswith('<@') and other_input.endswith('>'):
            try:
                uid = int(other_input[2:-1].replace('!', ''))
                u = await client.fetch_user(uid)
            except:
                pass
        else:
            try:
                u = await client.fetch_user(int(other_input))
            except:
                pass

        if not u:
            return await i.followup.send("Invalid user.", ephemeral=True)

        if u.id == i.user.id:
            return await i.followup.send("Can't trade with self.", ephemeral=True)

        idx = int(time.time() * 1000) % 1000000
        addr = get_addr(idx)

        c.execute(
            "INSERT INTO trades (buyer_id, currency, deposit_addr, channel_id, status) VALUES (?,?,?,?,?)",
            (str(i.user.id), self.currency, addr, "pending", 'waiting_role')
        )
        trade_id = c.lastrowid
        conn.commit()

        overwrites = {
            i.guild.default_role: discord.PermissionOverwrite(view_channel=False),
            i.user: discord.PermissionOverwrite(view_channel=True, send_messages=True),
            u: discord.PermissionOverwrite(view_channel=True, send_messages=True),
        }

        ch = await i.guild.create_text_channel(f"trade-{trade_id}", overwrites=overwrites)

        c.execute("UPDATE trades SET channel_id=? WHERE id=?", (ch.id, trade_id))
        conn.commit()

        view = RoleView(trade_id, i.user.id, u.id)

        await ch.send(
            f"**Trade #{trade_id}** | {self.currency}\n"
            f"Deposit: `{addr}`\n"
            f"{i.user.mention} gives: {self.you_give.value}\n"
            f"{u.mention} gives: {self.they_give.value}\n\n"
            f"{u.mention} pick role:", view=view
        )

        await i.followup.send(f"Ticket created: {ch.mention}", ephemeral=True)

# Role view
class RoleView(View):
    def __init__(self, tid, starter, other):
        super().__init__(timeout=None)
        self.tid = tid
        self.other = other

    @discord.ui.button(label="Sender", style=discord.ButtonStyle.green, custom_id="sender_btn")
    async def sender(self, i: discord.Interaction, _):
        if i.user.id != self.other:
            return await i.response.send_message("Not for you.", ephemeral=True)
        c.execute("UPDATE trades SET status='sender' WHERE id=?", (self.tid,))
        conn.commit()
        await i.response.send_message(f"{i.user.mention} is Sender", ephemeral=False)
        self.stop()

    @discord.ui.button(label="Receiver", style=discord.ButtonStyle.blurple, custom_id="receiver_btn")
    async def receiver(self, i: discord.Interaction, _):
        if i.user.id != self.other:
            return await i.response.send_message("Not for you.", ephemeral=True)
        c.execute("UPDATE trades SET status='receiver' WHERE id=?", (self.tid,))
        conn.commit()
        await i.response.send_message(f"{i.user.mention} is Receiver", ephemeral=False)
        self.stop()

# Panel
class PanelView(View):
    def __init__(self):
        super().__init__(timeout=None)
        opts = [
            SelectOption(label="Bitcoin", value="BTC", emoji="🟠"),
            SelectOption(label="Ethereum", value="ETH", emoji="💎"),
            SelectOption(label="Litecoin", value="LTC", emoji="🔷"),
            SelectOption(label="Solana", value="SOL", emoji="☀️"),
            SelectOption(label="USDT [ERC-20]", value="USDT_ERC20", emoji="💵"),
            SelectOption(label="USDC [ERC-20]", value="USDC_ERC20", emoji="💵"),
            SelectOption(label="USDT [SOL]", value="USDT_SOL", emoji="💵"),
            SelectOption(label="USDC [SOL]", value="USDC_SOL", emoji="💵"),
            SelectOption(label="USDT [BEP-20]", value="USDT_BEP20", emoji="💵"),
        ]
        sel = Select(placeholder="Make a selection", options=opts, custom_id="crypto_select_unique")

        @sel.callback
        async def cb(i: discord.Interaction):
            await i.response.send_modal(TradeModal(i.data['values'][0]))

        self.add_item(sel)

# Commands
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
    if i.user.id != OWNER_ID:
        c.execute("SELECT 1 FROM activated_users WHERE user_id=?", (str(i.user.id),))
        if not c.fetchone():
            return await i.response.send_message("Redeem a key first.", ephemeral=True)

    e = discord.Embed(title="Crypto Currency", description="**Fees:**\n• >250$: 2$\n• <250$: 1$\n• <50$: 0.7$\n• <10$: 0.3$\n• <5$: FREE")
    await i.response.send_message(embed=e, view=PanelView())

@client.event
async def on_ready():
    print(f'Logged in: {client.user}')
    try:
        synced = await tree.sync()
        print(f"Synced {len(synced)} global commands")
        for s in synced:
            print(f" - /{s.name}")
    except Exception as e:
        print(f"Global sync failed: {e}")

    # Instant guild sync - CHANGE TO YOUR SERVER ID
    YOUR_GUILD_ID = 123456789012345678  # REPLACE WITH YOUR REAL SERVER ID
    guild = client.get_guild(YOUR_GUILD_ID)
    if guild:
        try:
            await tree.sync(guild=guild)
            print(f"Guild sync done: {guild.name}")
        except Exception as e:
            print(f"Guild sync failed: {e}")

    client.add_view(PanelView())

async def setup_hook():
    client.loop.create_task(monitor())

client.setup_hook = setup_hook

async def monitor():
    await client.wait_until_ready()
    while not client.is_closed():
        await asyncio.sleep(60)

client.run(TOKEN)
