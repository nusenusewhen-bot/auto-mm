const axios = require('axios');

const API_KEY = process.env.CRYPTOAPIS_KEY;
const BASE_URL = 'https://rest.cryptoapis.io';

if (!API_KEY) {
  console.error('❌ CRYPTOAPIS_KEY not set in environment variables');
}

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

async function cryptoApisRequest(endpoint) {
  try {
    const url = `${BASE_URL}${endpoint}`;
    const res = await axios.get(url, {
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    return res.data.data;
  } catch (err) {
    console.error(`[CryptoApis] Error:`, err.message);
    return null;
  }
}

async function getAddressBalance(address) {
  const endpoint = `/addresses-latest/utxo/litecoin/mainnet/${address}/balance`;
  const data = await cryptoApisRequest(endpoint);
  
  if (!data) {
    return { confirmed: 0, unconfirmed: 0, total: 0 };
  }
  
  // Fix: Handle both direct and nested item structure
  const item = data.item || data;
  
  // Fix: Parse balance - CryptoAPIs returns objects with .amount or strings
  let confirmed = 0;
  let unconfirmed = 0;
  
  if (item.confirmedBalance) {
    if (typeof item.confirmedBalance === 'object' && item.confirmedBalance.amount) {
      confirmed = parseInt(item.confirmedBalance.amount);
    } else if (typeof item.confirmedBalance === 'string') {
      confirmed = parseInt(item.confirmedBalance);
    } else if (typeof item.confirmedBalance === 'number') {
      confirmed = item.confirmedBalance;
    }
  }
  
  if (item.unconfirmedBalance) {
    if (typeof item.unconfirmedBalance === 'object' && item.unconfirmedBalance.amount) {
      unconfirmed = parseInt(item.unconfirmedBalance.amount);
    } else if (typeof item.unconfirmedBalance === 'string') {
      unconfirmed = parseInt(item.unconfirmedBalance);
    } else if (typeof item.unconfirmedBalance === 'number') {
      unconfirmed = item.unconfirmedBalance;
    }
  }
  
  // Ensure we have valid numbers
  confirmed = isNaN(confirmed) ? 0 : confirmed;
  unconfirmed = isNaN(unconfirmed) ? 0 : unconfirmed;
  
  return {
    confirmed: confirmed / 1e8,
    unconfirmed: unconfirmed / 1e8,
    total: (confirmed + unconfirmed) / 1e8,
    source: 'cryptoapis'
  };
}

async function getAddressUTXOs(address) {
  const endpoint = `/addresses-historical/utxo/litecoin/mainnet/${address}/unspent-outputs`;
  const data = await cryptoApisRequest(endpoint);
  
  if (!data || !data.items) return [];
  
  return data.items.map(item => ({
    txid: item.transactionId,
    vout: item.index,
    value: parseInt(item.amount) || 0,
    confirmations: item.confirmations || 0
  }));
}

async function getTransactionHex(txid) {
  try {
    const endpoint = `/blockchain-data/litecoin/mainnet/transactions/${txid}`;
    const data = await cryptoApisRequest(endpoint);
    return data ? data.transactionHex : null;
  } catch (err) {
    return null;
  }
}

async function broadcastTransaction(txHex) {
  try {
    const url = `${BASE_URL}/broadcast-transactions/litecoin/mainnet`;
    const res = await axios.post(url, {
      data: {
        item: {
          rawTransaction: txHex
        }
      }
    }, {
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    return { 
      success: true, 
      txid: res.data.data.item.transactionId 
    };
  } catch (err) {
    return { 
      success: false, 
      error: err.response?.data?.message || err.message 
    };
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
    const endpoint = `/addresses-latest/utxo/litecoin/mainnet/${address}`;
    const data = await cryptoApisRequest(endpoint);
    
    if (!data) return null;
    
    // Fix: Check nested structure
    const item = data.item || data;
    
    let unconfirmedBal = 0;
    if (item.unconfirmedBalance) {
      if (typeof item.unconfirmedBalance === 'object' && item.unconfirmedBalance.amount) {
        unconfirmedBal = parseInt(item.unconfirmedBalance.amount);
      } else if (typeof item.unconfirmedBalance === 'string') {
        unconfirmedBal = parseInt(item.unconfirmedBalance);
      } else if (typeof item.unconfirmedBalance === 'number') {
        unconfirmedBal = item.unconfirmedBalance;
      }
    }
    
    if (unconfirmedBal > 0) {
      const txEndpoint = `/addresses-historical/utxo/litecoin/mainnet/${address}/unspent-outputs`;
      const txData = await cryptoApisRequest(txEndpoint);
      if (txData && txData.items && txData.items.length > 0) {
        return txData.items[0].transactionId;
      }
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
