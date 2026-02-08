// server.js - Use environment variables
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

// Load secrets from environment variables (provided by Elastic Beanstalk)
const SCHWAB_API_KEY = process.env.SCHWAB_API_KEY;
const SCHWAB_SECRET = process.env.SCHWAB_SECRET;
const SCHWAB_ACCESS_TOKEN = process.env.SCHWAB_ACCESS_TOKEN;

// Validate required environment variables
if (!SCHWAB_API_KEY || !SCHWAB_SECRET || !SCHWAB_ACCESS_TOKEN) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

// Proxy endpoint
app.all('/api/v1/*', async (req, res) => {
  try {
    const response = await axios({
      method: req.method,
      url: `https://api.schwabapi.com${req.url}`,
      headers: {
        'Authorization': `Bearer ${SCHWAB_ACCESS_TOKEN}`,
        'Schwab-Client-Key': SCHWAB_API_KEY,
        'Schwab-Client-Secret': SCHWAB_SECRET,
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
