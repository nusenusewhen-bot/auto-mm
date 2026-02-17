const axios = require('axios');
const { 
  isNodeConfigured,
  getAddressBalanceNode, 
  getAddressUTXOsNode, 
  getTransactionHexNode,
  broadcastTransactionNode,
  isNodeSynced 
} = require('./litecoin-node');

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 200;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(url, options = {}, retries = 3) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await delay(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }
  
  try {
    lastRequestTime = Date.now();
    const res = await axios.get(url, { 
      timeout: 15000,
      headers: { 'User-Agent': 'LTC-Bot/1.0' },
      ...options
    });
    return res;
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      console.log(`[Blockchain] Rate limited, waiting 3s...`);
      await delay(3000);
      return makeRequest(url, options, retries - 1);
    }
    throw err;
  }
}

// PRIMARY: Your own node (super fast, no limits)
// FALLBACK: BlockCypher/Blockchair
async function getAddressBalance(address, forceRefresh = false) {
  console.log(`[Balance] Checking ${address}`);
  
  // Try your own node first (instant, no rate limit)
  if (isNodeConfigured()) {
    const nodeSynced = await isNodeSynced();
    if (nodeSynced) {
      console.log(`[Balance] Using OWN NODE (fast)...`);
      const nodeResult = await getAddressBalanceNode(address);
      if (nodeResult) {
        console.log(`[Balance] Node: ${nodeResult.total} LTC (${nodeResult.confirmed} confirmed, ${nodeResult.unconfirmed} unconfirmed)`);
        return nodeResult;
      }
    }
  }
  
  console.log(`[Balance] Using BlockCypher (slow/rate-limited)...`);
  
  // Fallback to BlockCypher
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    
    const confirmed = (res.data.balance || 0) / 1e8;
    const unconfirmed = (res.data.unconfirmed_balance || 0) / 1e8;
    
    return {
      confirmed,
      unconfirmed,
      total: confirmed + unconfirmed,
      source: 'blockcypher'
    };
  } catch (err) {
    console.error(`[BlockCypher] Error:`, err.message);
    return await getBalanceBlockchair(address);
  }
}

async function getBalanceBlockchair(address) {
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
    console.error(`[Blockchair] Error:`, err.message);
    return { confirmed: 0, unconfirmed: 0, total: 0, source: 'none' };
  }
}

// Get UTXOs - Node first, then fallbacks
async function getAddressUTXOs(address) {
  console.log(`[UTXO] Fetching for ${address}`);
  
  // Try own node first (instant)
  if (isNodeConfigured()) {
    const nodeSynced = await isNodeSynced();
    if (nodeSynced) {
      const nodeUTXOs = await getAddressUTXOsNode(address);
      if (nodeUTXOs.length > 0) {
        console.log(`[UTXO] Node found ${nodeUTXOs.length} UTXOs (INSTANT)`);
        return nodeUTXOs;
      }
    }
  }
  
  // Fallback to BlockCypher (slow)
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    const data = res.data;
    
    const utxos = [];
    
    if (data.txrefs) {
      for (const tx of data.txrefs) {
        if (tx.tx_output_n >= 0) {
          utxos.push({
            txid: tx.tx_hash,
            vout: tx.tx_output_n,
            value: tx.value,
            confirmations: tx.confirmations || 0
          });
        }
      }
    }
    
    if (data.unconfirmed_txrefs) {
      for (const tx of data.unconfirmed_txrefs) {
        if (tx.tx_output_n >= 0) {
          const exists = utxos.some(u => u.txid === tx.tx_hash && u.vout === tx.tx_output_n);
          if (!exists) {
            utxos.push({
              txid: tx.tx_hash,
              vout: tx.tx_output_n,
              value: tx.value,
              confirmations: 0
            });
          }
        }
      }
    }
    
    console.log(`[UTXO] BlockCypher found ${utxos.length} UTXOs (slow)`);
    return utxos;
    
  } catch (err) {
    console.error('[UTXO] BlockCypher failed:', err.message);
    return await getUTXOsBlockchair(address);
  }
}

async function getUTXOsBlockchair(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?limit=100`;
    const res = await axios.get(url, { timeout: 10000 });
    
    const data = res.data.data[address];
    const utxos = [];
    
    if (data.utxo) {
      for (const utxo of data.utxo) {
        utxos.push({
          txid: utxo.transaction_hash,
          vout: utxo.index,
          value: utxo.value,
          confirmations: utxo.block_id ? 1 : 0
        });
      }
    }
    
    console.log(`[UTXO] Blockchair found ${utxos.length} UTXOs`);
    return utxos;
  } catch (err) {
    return [];
  }
}

// Get transaction hex - Node first
async function getTransactionHex(txid) {
  // Try node first (instant)
  if (isNodeConfigured()) {
    const nodeHex = await getTransactionHexNode(txid);
    if (nodeHex) return nodeHex;
  }
  
  // Fallback to BlockCypher
  try {
    const url = `${BLOCKCYPHER_BASE}/txs/${txid}?includeHex=true&token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    if (res.data.hex) return res.data.hex;
  } catch (err) {
    // Try Blockchair
    try {
      const url = `https://api.blockchair.com/litecoin/raw/transaction/${txid}`;
      const res = await axios.get(url, { timeout: 10000 });
      return res.data.data[txid].raw_transaction;
    } catch (e) {
      return null;
    }
  }
}

// Broadcast - Node first
async function broadcastTransaction(txHex) {
  // Try node first (instant confirmation)
  if (isNodeConfigured()) {
    const nodeResult = await broadcastTransactionNode(txHex);
    if (nodeResult.success) {
      console.log(`[Broadcast] Sent via OWN NODE (instant)`);
      return nodeResult;
    }
  }
  
  console.log(`[Broadcast] Node failed, trying BlockCypher...`);
  
  // Fallback to BlockCypher
  try {
    const res = await axios.post(
      `${BLOCKCYPHER_BASE}/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex },
      { timeout: 30000, headers: { 'Content-Type': 'application/json' }}
    );
    
    if (res.data?.tx?.hash) {
      return { success: true, txid: res.data.tx.hash };
    }
  } catch (err) {
    return { success: false, error: err.response?.data?.error || err.message };
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
  if (!address) return null;
  
  // Try node first
  if (isNodeConfigured()) {
    try {
      const { rpcCall } = require('./litecoin-node');
      const mempool = await rpcCall('getaddressmempool', [{addresses: [address]}]);
      if (mempool && mempool.length > 0) {
        return mempool[0].txid;
      }
    } catch (e) {
      // Fallback to BlockCypher
    }
  }
  
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    
    if (res.data.unconfirmed_n_tx > 0 && res.data.unconfirmed_txrefs?.length > 0) {
      return res.data.unconfirmed_txrefs[0].tx_hash;
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
  checkTransactionMempool,
  delay
};
