const axios = require('axios');
const { 
  isNodeConfigured,
  getAddressBalanceNode, 
  getAddressUTXOsNode, 
  getTransactionHexNode,
  broadcastTransactionNode,
  isNodeSynced,
  getAddressMempool
} = require('./litecoin-node');

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ONLY use your own node - no more rate limits
async function getAddressBalance(address, forceRefresh = false) {
  console.log(`[Balance] Checking ${address}`);
  
  if (!isNodeConfigured()) {
    console.error('[Balance] Node not configured!');
    return { confirmed: 0, unconfirmed: 0, total: 0, source: 'none' };
  }
  
  const nodeSynced = await isNodeSynced();
  if (!nodeSynced) {
    console.log('[Balance] Node not synced yet...');
    return { confirmed: 0, unconfirmed: 0, total: 0, source: 'syncing' };
  }
  
  console.log(`[Balance] Using OWN NODE (fast)...`);
  const nodeResult = await getAddressBalanceNode(address);
  if (nodeResult) {
    console.log(`[Balance] Node: ${nodeResult.total} LTC (${nodeResult.confirmed} confirmed, ${nodeResult.unconfirmed} unconfirmed)`);
    return nodeResult;
  }
  
  return { confirmed: 0, unconfirmed: 0, total: 0, source: 'none' };
}

// Get UTXOs - Node only
async function getAddressUTXOs(address) {
  console.log(`[UTXO] Fetching for ${address}`);
  
  if (!isNodeConfigured()) {
    console.error('[UTXO] Node not configured!');
    return [];
  }
  
  const nodeSynced = await isNodeSynced();
  if (!nodeSynced) {
    console.log('[UTXO] Node not synced yet...');
    return [];
  }
  
  const nodeUTXOs = await getAddressUTXOsNode(address);
  console.log(`[UTXO] Node found ${nodeUTXOs.length} UTXOs (INSTANT)`);
  return nodeUTXOs;
}

// Get transaction hex - Node only
async function getTransactionHex(txid) {
  if (!isNodeConfigured()) return null;
  
  const nodeHex = await getTransactionHexNode(txid);
  if (nodeHex) return nodeHex;
  
  return null;
}

// Broadcast - Node only (instant confirmation)
async function broadcastTransaction(txHex) {
  if (!isNodeConfigured()) {
    return { success: false, error: 'Node not configured' };
  }
  
  console.log(`[Broadcast] Sending via OWN NODE (instant)`);
  const nodeResult = await broadcastTransactionNode(txHex);
  
  if (nodeResult.success) {
    console.log(`[Broadcast] Sent via OWN NODE: ${nodeResult.txid}`);
    return nodeResult;
  }
  
  return { success: false, error: nodeResult.error || 'Broadcast failed' };
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
  
  if (isNodeConfigured()) {
    try {
      const mempool = await getAddressMempool(address);
      if (mempool && mempool.length > 0) {
        return mempool[0].txid;
      }
    } catch (e) {
      // Ignore errors
    }
  }
  
  return null;
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
