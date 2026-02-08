// server.js - Load secrets from AWS SSM
const AWS = require('aws-sdk');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

// Configure AWS SDK
AWS.config.update({ region: 'us-east-1' });
const ssm = new AWS.SSM();

// Cache parameters to avoid repeated calls
let cachedSecrets = null;

async function getSecrets() {
  if (cachedSecrets) return cachedSecrets;
  
  try {
    const params = {
      Names: [
        '/schwab-proxy/api-key',
        '/schwab-proxy/secret', 
        '/schwab-proxy/access-token'
      ],
      WithDecryption: true
    };
    
    const response = await ssm.getParameters(params).promise();
    
    cachedSecrets = {
      SCHWAB_API_KEY: response.Parameters.find(p => p.Name === '/schwab-proxy/api-key').Value,
      SCHWAB_SECRET: response.Parameters.find(p => p.Name === '/schwab-proxy/secret').Value,
      SCHWAB_ACCESS_TOKEN: response.Parameters.find(p => p.Name === '/schwab-proxy/access-token').Value
    };
    
    return cachedSecrets;
  } catch (error) {
    console.error('Failed to load secrets from SSM:', error);
    throw error;
  }
}

const app = express();
app.use(cors());

// Proxy endpoint with secure credentials
app.all('/api/v1/*', async (req, res) => {
  try {
    const secrets = await getSecrets();
    
    const response = await axios({
      method: req.method,
      url: `https://api.schwabapi.com${req.url}`,
      headers: {
        'Authorization': `Bearer ${secrets.SCHWAB_ACCESS_TOKEN}`,
        'Schwab-Client-Key': secrets.SCHWAB_API_KEY,
        'Schwab-Client-Secret': secrets.SCHWAB_SECRET,
        ...req.headers
      },
      data: req.body
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ error: 'Proxy request failed' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Schwab proxy server running on port ${PORT}`);
});
