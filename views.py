import discord
from discord.ui import View, Select, Modal, TextInput
import time
from bot import get_addr, conn, c, client  # Import shared from bot.py (safe now)

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
        sel = Select(placeholder="Make a selection", options=opts, custom_id="crypto_panel_select")

        @sel.callback
        async def cb(i: discord.Interaction):
            await i.response.send_modal(TradeModal(i.data['values'][0]))

        self.add_item(sel)
