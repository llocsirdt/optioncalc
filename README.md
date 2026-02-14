# 📊 Options Calculator with Schwab API Integration

A comprehensive options trading calculator with real-time Schwab API integration, featuring a clean client-server architecture with persistence capabilities.

## 🏗️ Project Structure

```
optioncalc/
├── index.html              # Main HTML page (root)
├── 📁 client/                 # Frontend UI Application
│   ├── styles.css            # UI styling
│   └── lib/                  # All client-side utilities
│       ├── schwab-api.js     # Client-side API integration
│       ├── chart.js          # Charting functionality
│       ├── option-utils.js   # Options calculation utilities
│       ├── expiration-dropdown.js # Expiration date handling
│       ├── bull-call-spread-offsetting.js # Bull call spread tools
│       ├── bear-put-spread-offsetting.js # Bear put spread tools
│       ├── single-leg-offsetting.js # Single leg offsetting tools
│       ├── oc.js             # Options calculator core
│       └── offsetting-trades.js # Trade utilities
├── 📁 server/                 # Backend Server Application
│   ├── src/
│   │   ├── proxy-server-sdk.js    # Main server file
│   │   └── persistence/
│   │       ├── persistence.js     # Local persistence manager
│   │       └── eb-persistence.js   # AWS EB persistence manager
│   ├── .ebextensions/        # AWS Elastic Beanstalk configuration
│   └── package.json          # Server dependencies
├── 📁 docs/                   # Project Documentation
│   ├── API_SAMPLES.md        # API documentation
│   ├── PERSISTENCE_README.md # Persistence system docs
│   ├── EB_DEPLOYMENT_GUIDE.md # AWS deployment guide
│   ├── TEST_README.md        # Testing documentation
│   ├── SCHWAB_SETUP.md       # Schwab API setup guide
│   ├── SCHWAB_SETUP_UNSAFE.md # Alternative setup method
│   └── README.md             # This file
├── 📁 tests/                  # Testing Suite
│   └── test-apis.js          # API integration tests
├── 📁 scripts/                # Shell Scripts
│   ├── create-deployment-package.sh
│   ├── create-secret.sh
│   ├── quick-zip.sh
│   ├── restart-proxy.sh
│   ├── set-eb-env-vars.sh
│   └── setup-ssm-parameters.sh
├── 📁 data/                   # Data Files
└── ⚙️  Configuration
    ├── .env                   # Environment variables (NOT in git)
    ├── .gitignore             # Git ignore rules
    └── package.json           # Root workspace configuration
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ installed
- Schwab API credentials
- AWS CLI (for deployment)

### 1. Environment Setup
```bash
# Copy environment template
cp .env.example .env

# Edit with your credentials
nano .env
```

Required environment variables:
```env
SCHWAB_CLIENT_ID=your_client_id
SCHWAB_CLIENT_SECRET=your_client_secret
SCHWAB_REFRESH_TOKEN=your_refresh_token
ACCOUNT_HASH=your_account_hash
PORT=3001
```

### 2. Install Dependencies
```bash
# Install root workspace dependencies
npm install

# Install server dependencies
npm run install:server
```

### 3. Start Development Server
```bash
# Start the proxy server
npm run dev

# Or start from server directory
cd server && npm run dev
```

### 4. Open Client
Open `index.html` in your browser (it's in the root directory) or serve it with a web server.

## 📡 API Endpoints

### Health Check
```bash
curl "http://localhost:3001/health"
```

### State Management
```bash
# View server state
curl "http://localhost:3001/api/v1/admin/state"

# Save state
curl -X POST "http://localhost:3001/api/v1/admin/state/save"
```

### Market Data
```bash
# Get quotes
curl "http://localhost:3001/api/v1/marketdata/quotes?symbols=SPY"

# Get option expirations
curl "http://localhost:3001/api/v1/marketdata/expirationchain?symbol=SPY"
```

### Trading
```bash
# Get account numbers
curl "http://localhost:3001/api/v1/trading/accounts/accountNumbers"

# Get account details
curl "http://localhost:3001/api/v1/trading/accounts/HASH"

# Place order
curl -X POST "http://localhost:3001/api/v1/trading/HASH/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderType": "LIMIT", "session": "NORMAL", "duration": "DAY", "orderStrategyType": "SINGLE", "price": "1.00", "orderLegCollection": [{"instruction": "BUY", "quantity": 1, "instrument": {"symbol": "THAR", "assetType": "EQUITY"}}]}'
```

## 🧪 Testing

### Run API Tests
```bash
# Run comprehensive API tests
npm test

# Or run from tests directory
cd tests && node test-apis.js
```

### Test Coverage
- ✅ Health check endpoint
- ✅ Market data endpoints
- ✅ Account management endpoints
- ✅ Order placement and cancellation
- ✅ Persistence system
- ✅ Error handling

## 🗄️ Persistence System

The server includes a comprehensive persistence system that maintains state across restarts:

### Features
- **Order tracking** - Active and completed orders
- **Error logging** - Recent error history
- **Account caching** - Account information
- **Session management** - Token and session data
- **Automatic cleanup** - Old data removal

### Management
```bash
# View state summary
curl "http://localhost:3001/api/v1/admin/state" | jq .summary

# Clean up old data
curl -X POST "http://localhost:3001/api/v1/admin/state/cleanup"

# Reset state
curl -X POST "http://localhost:3001/api/v1/admin/state/reset"
```

## 🚀 Deployment

### Local Development
```bash
# Start development server
npm run dev
```

### AWS Elastic Beanstalk
```bash
# Install EB CLI
pip install awsebcli

# Initialize EB application
eb init optioncalc

# Create environment
eb create production

# Deploy
eb deploy production
```

For detailed deployment instructions, see [EB_DEPLOYMENT_GUIDE.md](docs/EB_DEPLOYMENT_GUIDE.md).

## 📚 Documentation

- [API_SAMPLES.md](docs/API_SAMPLES.md) - Complete API documentation
- [PERSISTENCE_README.md](docs/PERSISTENCE_README.md) - Persistence system guide
- [EB_DEPLOYMENT_GUIDE.md](docs/EB_DEPLOYMENT_GUIDE.md) - AWS deployment guide
- [TEST_README.md](docs/TEST_README.md) - Testing documentation
- [SCHWAB_SETUP.md](docs/SCHWAB_SETUP.md) - Schwab API setup
- [SCHWAB_SETUP_UNSAFE.md](docs/SCHWAB_SETUP_UNSAFE.md) - Alternative setup method

## 🛠️ Development

### Client Development
- Frontend files in `client/`
- Uses vanilla JavaScript
- Real-time API integration
- Interactive options calculator

### Server Development
- Backend files in `server/`
- Express.js with persistence
- Schwab SDK integration
- RESTful API design

### Tools and Utilities
- Options offsetting tools in `tools/offsetting/`
- Deployment scripts in `scripts/`
- Setup documentation in `setup/`

## 🔧 Configuration

### Environment Variables
| Variable | Description | Required |
|----------|-------------|----------|
| `SCHWAB_CLIENT_ID` | Schwab API client ID | ✅ |
| `SCHWAB_CLIENT_SECRET` | Schwab API client secret | ✅ |
| `SCHWAB_REFRESH_TOKEN` | Schwab API refresh token | ✅ |
| `ACCOUNT_HASH` | Encrypted account hash | ✅ |
| `PORT` | Server port (default: 3001) | ❌ |

### Server Configuration
- Port: 3001 (configurable via `PORT` env var)
- CORS enabled for all origins
- JSON request parsing
- Comprehensive error handling
- Automatic state persistence

## 🔒 Security

- Environment variables for sensitive data
- No credentials in source code
- CORS configuration
- Input validation
- Error message sanitization

## 📊 Architecture

### Client-Server Separation
- **Client**: Frontend UI and calculations
- **Server**: API proxy and persistence
- **Independent**: Can be deployed separately

### Persistence Layer
- **Local Storage**: JSON-based file persistence
- **Backup System**: Automatic backup creation
- **Cleanup**: Automatic old data removal
- **EB Compatible**: Works with AWS Elastic Beanstalk

### API Design
- **RESTful**: Standard HTTP methods
- **Environment-based**: Uses `HASH` placeholder
- **Error Handling**: Comprehensive error responses
- **Documentation**: Complete API samples

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

## 🆘 Support

For issues and questions:
1. Check documentation in `docs/`
2. Review test outputs
3. Check server logs
4. Create an issue with details

---

**Built with ❤️ for options trading automation**
