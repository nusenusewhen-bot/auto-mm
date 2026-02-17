const axios = require('axios');

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

async function getAddressBalance(address, forceRefresh = false) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}`;
    const res = await axios.get(url, { timeout: 10000 });
    
    const data = res.data.data[address];
    const balance = (data.address.balance || 0) / 1e8;
    
    return {
      confirmed: balance,
      unconfirmed: 0,
      total: balance,
      source: 'blockchair'
    };
  } catch (err) {
    console.error('Balance check error:', err.message);
    return { confirmed: 0, unconfirmed: 0, total: 0 };
  }
}

async function getAddressUTXOs(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?limit=100`;
    const res = await axios.get(url, { timeout: 10000 });
    
    const data = res.data.data[address];
    if (!data.utxo) return [];
    
    return data.utxo.map(u => ({
      txid: u.transaction_hash,
      vout: u.index,
      value: u.value,
      confirmations: u.block_id ? 1 : 0
    }));
  } catch (err) {
    console.error('UTXO fetch error:', err.message);
    return [];
  }
}

async function getTransactionHex(txid) {
  try {
    const url = `https://api.blockchair.com/litecoin/raw/transaction/${txid}`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data.data[txid].raw_transaction;
  } catch (err) {
    return null;
  }
}

async function broadcastTransaction(txHex) {
  try {
    const res = await axios.post(
      'https://api.blockcypher.com/v1/ltc/main/txs/push',
      { tx: txHex },
      { timeout: 30000 }
    );
    return { success: true, txid: res.data.tx.hash };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getLtcPriceUSD() {
  const now = Date.now();
  if (now - priceCache.timestamp < CACHE_DURATION && priceCache.value > 0) {
    return priceCache.value;
  }

  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd',
      { timeout: 5000 }
    );
    priceCache = { value: res.data.litecoin.usd, timestamp: now };
    return priceCache.value;
  } catch (err) {
    return priceCache.value || 0;
  }
}

async function checkTransactionMempool(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}`;
    const res = await axios.get(url, { timeout: 10000 });
    const data = res.data.data[address];
    
    if (data.transactions && data.transactions.length > 0) {
      return data.transactions[0];
    }
    return null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  getAddressBalance,
  getAddressUTXOs,
  getTransactionHex,
  broadcastTransaction,
  getLtcPriceUSD,
  checkTransactionMempool
};
