import discord
from discord import app_commands
import os
import asyncio
from dotenv import load_dotenv
from shared import conn, c, get_addr, wallet  # Safe shared import
from views import PanelView  # UI only

load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')

if not TOKEN:
    print("DISCORD_TOKEN missing")
    exit(1)

OWNER_ID = 1298640383688970293

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

@client.event
async def on_ready():
    print(f'Logged in: {client.user} (ID: {client.user.id})')

    # Force sync
    try:
        synced = await tree.sync()
        print(f"Global sync: {len(synced)} commands")
        for s in synced:
            print(f" - /{s.name}")
    except Exception as e:
        print(f"Global sync failed: {e}")

    # Instant guild sync (CHANGE TO YOUR SERVER ID)
    YOUR_GUILD_ID = 123456789012345678  # ← REPLACE THIS
    guild = client.get_guild(YOUR_GUILD_ID)
    if guild:
        try:
            await tree.sync(guild=guild)
            print(f"Guild sync done: {guild.name}")
        except Exception as e:
            print(f"Guild sync failed: {e}")

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
