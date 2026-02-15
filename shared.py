import sqlite3
from dotenv import load_dotenv
import os

load_dotenv()

# Database (shared)
conn = sqlite3.connect('trades.db')
c = conn.cursor()
c.execute('CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0)')
c.execute('CREATE TABLE IF NOT EXISTS activated_users (user_id TEXT PRIMARY KEY)')
c.execute('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, buyer_id TEXT, currency TEXT, deposit_addr TEXT, channel_id TEXT, status TEXT DEFAULT "waiting_role")')
conn.commit()

# Wallet (shared)
from bitcoinlib.wallets import Wallet, wallet_exists, WalletError

wallet = None
MNEMONIC = os.getenv('BOT_MNEMONIC')
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
