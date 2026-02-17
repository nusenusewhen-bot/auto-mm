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
  console.log(`\n[TX] ========== Fetching hex for ${txid} ==========`);
  
  try {
    // Try 1: Blockchair Paid (if available)
    if (BLOCKCHAIR_KEY && usePaidPlan) {
      console.log(`[TX] Trying Blockchair PAID...`);
      const url = `${BASE_URL}/raw/transaction/${txid}?key=${BLOCKCHAIR_KEY}`;
      
      try {
        const res = await axios.get(url, { timeout: 30000 });
        console.log(`[TX] Blockchair PAID status: ${res.status}`);
        
        if (res.data?.data?.[txid]?.raw_transaction) {
          console.log(`[TX] ✓ Got hex from Blockchair PAID`);
          return res.data.data[txid].raw_transaction;
        }
      } catch (err) {
        if (err.response?.status === 402 || err.response?.status === 429) {
          console.log(`[TX] Blockchair PAID credits exhausted`);
          usePaidPlan = false;
        } else {
          console.log(`[TX] Blockchair PAID failed: ${err.message}`);
        }
      }
    }
    
    // Try 2: Blockchair Free
    console.log(`[TX] Trying Blockchair FREE...`);
    try {
      const url = `${BASE_URL}/raw/transaction/${txid}`;
      const res = await axios.get(url, { timeout: 30000 });
      
      if (res.data?.data?.[txid]?.raw_transaction) {
        console.log(`[TX] ✓ Got hex from Blockchair FREE`);
        return res.data.data[txid].raw_transaction;
      }
    } catch (err) {
      console.log(`[TX] Blockchair FREE failed: ${err.message}`);
      if (err.response?.data?.context?.error) {
        console.log(`[TX] Blockchair error: ${err.response.data.context.error}`);
      }
    }
    
    // Try 3: BlockCypher (reliable fallback)
    console.log(`[TX] Trying BlockCypher fallback...`);
    try {
      const url = `https://api.blockcypher.com/v1/ltc/main/txs/${txid}?includeHex=true`;
      const res = await axios.get(url, { timeout: 30000 });
      
      if (res.data?.hex) {
        console.log(`[TX] ✓ Got hex from BlockCypher`);
        return res.data.hex;
      }
    } catch (err) {
      console.log(`[TX] BlockCypher failed: ${err.message}`);
    }
    
    // Try 4: Alternative Blockchair endpoint
    console.log(`[TX] Trying Blockchair dashboard endpoint...`);
    try {
      let url = `${BASE_URL}/dashboards/transaction/${txid}`;
      if (BLOCKCHAIR_KEY) url += `?key=${BLOCKCHAIR_KEY}`;
      
      const res = await axios.get(url, { timeout: 30000 });
      if (res.data?.data?.[txid]?.raw_transaction) {
        console.log(`[TX] ✓ Got hex from Blockchair dashboard`);
        return res.data.data[txid].raw_transaction;
      }
    } catch (err) {
      console.log(`[TX] Blockchair dashboard failed: ${err.message}`);
    }
    
    console.error(`[TX] ✗ All methods failed for ${txid}`);
    return null;
    
  } catch (err) {
    console.error(`[TX] Critical error: ${err.message}`);
    return null;
  }
}

async function broadcastTransaction(txHex) {
  // Try Blockchair first
  try {
    let url = `${BASE_URL}/push/transaction`;
    if (BLOCKCHAIR_KEY && usePaidPlan) {
      url += `?key=${BLOCKCHAIR_KEY}`;
    }
    
    console.log(`[Broadcast] Trying Blockchair...`);
    const res = await axios.post(url, { data: txHex }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    
    if (res.data?.data?.transaction_hash) {
      console.log(`[Broadcast] ✓ Success via Blockchair`);
      return { 
        success: true, 
        txid: res.data.data.transaction_hash 
      };
    }
  } catch (err) {
    console.log(`[Broadcast] Blockchair failed: ${err.message}`);
    
    if (err.response?.status === 402 || err.response?.status === 429) {
      usePaidPlan = false;
    }
  }
  
  // Fallback to BlockCypher
  try {
    console.log(`[Broadcast] Trying BlockCypher...`);
    const url = `https://api.blockcypher.com/v1/ltc/main/txs/push`;
    const res = await axios.post(url, { tx: txHex }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    
    if (res.data?.tx?.hash) {
      console.log(`[Broadcast] ✓ Success via BlockCypher`);
      return { 
        success: true, 
        txid: res.data.tx.hash 
      };
    }
  } catch (err) {
    console.log(`[Broadcast] BlockCypher failed: ${err.message}`);
    return { 
      success: false, 
      error: err.response?.data?.error || err.message 
    };
  }
  
  return { success: false, error: 'All broadcast methods failed' };
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
  console.log('✅ [Blockchair] PAID plan active (will fallback to BlockCypher if needed)');
} else {
  console.log('✅ [Blockchair] FREE plan + BlockCypher fallback');
}

module.exports = {
  getAddressBalance,
  getAddressUTXOs,
  getTransactionHex,
  broadcastTransaction,
  getLtcPriceUSD,
  checkTransactionMempool
};
