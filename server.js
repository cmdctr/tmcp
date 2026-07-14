// server.js - Web-Ready Stateless Proxy
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
// Use the hosting provider's port if available, otherwise default to 3000
const PORT = process.env.PORT || 3000;
const MCP_ENDPOINT = 'https://mcp.tafsir.net/mcp';

app.use(cors());
app.use(bodyParser.json());

/**
 * Helper: Reads the SSE stream and resolves IMMEDIATELY 
 * when it finds a valid JSON-RPC response matching the expected ID.
 */
async function readSSEStream(stream, expectedId = null) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      buffer = lines.pop(); // Keep the last incomplete line in the buffer
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.substring(6).trim();
            if (jsonStr) {
              const parsed = JSON.parse(jsonStr);
              if (parsed.jsonrpc === '2.0') {
                if (!expectedId || parsed.id === expectedId) {
                  return parsed;
                }
              }
            }
          } catch (e) {
            // Skip non-JSON or malformed lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  return null;
}

/**
 * Helper: Fetch wrapper with an AbortController for timeouts
 */
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// NEW: Endpoint to initialize a session for a specific client
app.post('/init', async (req, res) => {
  try {
    console.log('🔄 Initializing new client session...');
    const reqId = Date.now();
    
    const response = await fetchWithTimeout(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        'User-Agent': 'ClaudeDesktop/1.0.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Origin': 'https://claude.ai',
        'Referer': 'https://claude.ai/',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'claude-desktop', version: '1.0.0' }
        },
        id: reqId
      })
    });

    const newSessionId = response.headers.get('mcp-session-id');
    if (!newSessionId) {
      throw new Error('No session ID received from server headers');
    }
    
    const result = await readSSEStream(response.body, reqId);
    if (result?.error) throw new Error(`Init failed: ${result.error.message}`);
    
    console.log(`✅ Session created: ${newSessionId}`);
    res.json({ sessionId: newSessionId });
  } catch (error) {
    console.error('❌ Init error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stateless MCP tool caller
async function callMcp(toolName, args, sessionId) {
  console.log(`📤 Calling tool: ${toolName} for session: ${sessionId.substring(0,6)}...`);
  const reqId = Date.now();
  
  const payload = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args || {} },
    id: reqId
  };

  try {
    const response = await fetchWithTimeout(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        'mcp-session-id': sessionId, // Inject the client's specific ID
        'User-Agent': 'ClaudeDesktop/1.0.0',
        'Origin': 'https://claude.ai',
        'Referer': 'https://claude.ai/'
      },
      body: JSON.stringify(payload)
    });

    const result = await readSSEStream(response.body, reqId);
    
    if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error));
    if (!result) throw new Error('No valid JSONRPC response received from stream.');
    
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timed out.');
    throw error;
  }
}

// Proxy endpoint (Now requires x-mcp-session-id header)
app.post('/mcp', async (req, res) => {
  try {
    const { tool, args } = req.body;
    const sessionId = req.headers['x-mcp-session-id']; // Read ID from frontend

    if (!sessionId) {
      return res.status(401).json({ error: 'Missing session ID. Please initialize first.', isSessionError: true });
    }
    if (!tool) {
      return res.status(400).json({ error: 'Missing "tool" field' });
    }

    const result = await callMcp(tool, args || {}, sessionId);
    res.json(result);
  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    // Detect if the error is due to an expired session
    const isSessionError = error.message.includes('session') || error.message.includes('-32000');
    res.status(isSessionError ? 401 : 500).json({ error: error.message, isSessionError });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', endpoint: MCP_ENDPOINT });
});

app.listen(PORT, () => {
  console.log(`✅ Stateless Tafsir Proxy running on port ${PORT}`);
});

export default app;
