const axios = require('axios');

const BLOCKCHAIR_KEY = process.env.BLOCKCHAIR_KEY;
const BASE_URL = 'https://api.blockchair.com/litecoin';

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;
let usePaidPlan = !!BLOCKCHAIR_KEY;

async function blockchairRequest(endpoint) {
  try {
    let url = `${BASE_URL}${endpoint}`;
    
    if (BLOCKCHAIR_KEY && usePaidPlan) {
      url += `${endpoint.includes('?') ? '&' : '?'}key=${BLOCKCHAIR_KEY}`;
    }
    
    const res = await axios.get(url, { timeout: 30000 });
    
    if (res.data && res.data.context && res.data.context.error) {
      if (res.data.context.error.includes('credits') || res.data.context.error.includes('limit')) {
        console.log('[Blockchair] Paid credits exhausted, falling back to free plan');
        usePaidPlan = false;
        return await blockchairRequestFree(endpoint);
      }
    }
    
    return res.data.data;
  } catch (err) {
    if (err.response && (err.response.status === 402 || err.response.status === 429)) {
      console.log('[Blockchair] Paid plan hit limit, using free tier...');
      usePaidPlan = false;
      return await blockchairRequestFree(endpoint);
    }
    
    console.error(`[Blockchair] Error:`, err.message);
    return null;
  }
}

async function blockchairRequestFree(endpoint) {
  try {
    const url = `${BASE_URL}${endpoint}`;
    const res = await axios.get(url, { timeout: 30000 });
    return res.data.data;
  } catch (err) {
    console.error(`[Blockchair Free] Error:`, err.message);
    return null;
  }
}

async function getAddressBalance(address) {
  const data = await blockchairRequest(`/dashboards/address/${address}`);
  
  if (!data || !data[address]) {
    return { confirmed: 0, unconfirmed: 0, total: 0 };
  }
  
  const addressData = data[address];
  const balance = addressData.address.balance || 0;
  
  let unconfirmed = 0;
  if (addressData.utxo) {
    unconfirmed = addressData.utxo
      .filter(u => u.block_id === -1 && !u.is_spent)
      .reduce((sum, u) => sum + u.value, 0);
  }
  
  const confirmed = balance - unconfirmed;
  
  return {
    confirmed: confirmed / 1e8,
    unconfirmed: unconfirmed / 1e8,
    total: balance / 1e8,
    source: usePaidPlan ? 'blockchair-paid' : 'blockchair-free'
  };
}

async function getAddressUTXOs(address) {
  const data = await blockchairRequest(`/dashboards/address/${address}`);
  
  if (!data || !data[address] || !data[address].utxo) {
    console.log(`[Blockchair] No UTXOs found for ${address}`);
    return [];
  }
  
  const utxos = data[address].utxo
    .filter(u => !u.is_spent)
    .map(u => ({
      txid: u.transaction_hash,
      vout: u.index,
      value: parseInt(u.value),
      confirmations: u.block_id > 0 ? 1 : 0
    }));
  
  console.log(`[Blockchair] Found ${utxos.length} UTXOs for ${address}`);
  return utxos;
}

async function getTransactionHex(txid) {
  try {
    // CRITICAL FIX: Must include API key for raw transaction endpoint
    let url = `${BASE_URL}/raw/transaction/${txid}`;
    if (BLOCKCHAIR_KEY && usePaidPlan) {
      url += `?key=${BLOCKCHAIR_KEY}`;
    }
    
    console.log(`[Blockchair] Fetching raw tx for ${txid}...`);
    const res = await axios.get(url, { timeout: 30000 });
    
    if (!res.data || !res.data.data) {
      console.error(`[Blockchair] No data for tx ${txid}`);
      return null;
    }
    
    const txData = res.data.data[txid];
    if (!txData) {
      console.error(`[Blockchair] Transaction ${txid} not found in response`);
      return null;
    }
    
    if (!txData.raw_transaction) {
      console.error(`[Blockchair] No raw_transaction field for ${txid}`);
      return null;
    }
    
    console.log(`[Blockchair] Got hex for ${txid}: ${txData.raw_transaction.substring(0, 30)}...`);
    return txData.raw_transaction;
  } catch (err) {
    console.error(`[Blockchair] getTransactionHex error for ${txid}:`, err.message);
    if (err.response?.data?.context?.error) {
      console.error(`[Blockchair] API Error:`, err.response.data.context.error);
    }
    // If paid plan fails, try free
    if (BLOCKCHAIR_KEY && usePaidPlan && err.response && (err.response.status === 402 || err.response.status === 429)) {
      console.log('[Blockchair] Raw tx: Switching to free plan for this request...');
      usePaidPlan = false;
      return await getTransactionHex(txid);
    }
    return null;
  }
}

async function broadcastTransaction(txHex) {
  try {
    let url = `${BASE_URL}/push/transaction`;
    if (BLOCKCHAIR_KEY && usePaidPlan) {
      url += `?key=${BLOCKCHAIR_KEY}`;
    }
    
    const res = await axios.post(url, { data: txHex }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    
    if (res.data && res.data.data && res.data.data.transaction_hash) {
      return { 
        success: true, 
        txid: res.data.data.transaction_hash 
      };
    } else {
      return { success: false, error: 'Unknown response from Blockchair' };
    }
  } catch (err) {
    if (BLOCKCHAIR_KEY && usePaidPlan && err.response && (err.response.status === 402 || err.response.status === 429)) {
      console.log('[Blockchair] Broadcast: Switching to free plan...');
      usePaidPlan = false;
      return await broadcastTransaction(txHex);
    }
    
    return { 
      success: false, 
      error: err.response?.data?.context?.error || err.message 
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
    const data = await blockchairRequest(`/dashboards/address/${address}`);
    if (!data || !data[address]) return null;
    
    const utxos = data[address].utxo || [];
    const unconfirmedUtxo = utxos.find(u => u.block_id === -1 && !u.is_spent);
    
    return unconfirmedUtxo ? unconfirmedUtxo.transaction_hash : null;
  } catch (err) {
    return null;
  }
}

if (BLOCKCHAIR_KEY) {
  console.log('✅ [Blockchair] Using PAID plan (10k requests)');
} else {
  console.log('✅ [Blockchair] Using FREE plan (30 req/min)');
}

module.exports = {
  getAddressBalance,
  getAddressUTXOs,
  getTransactionHex,
  broadcastTransaction,
  getLtcPriceUSD,
  checkTransactionMempool
};
