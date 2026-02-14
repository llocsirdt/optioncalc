# 🗄️ Data Persistence System

## Overview

The Schwab Proxy Server now includes a comprehensive data persistence system that saves and restores server state across restarts. This ensures continuity of operations and provides valuable debugging capabilities.

## 🚀 Quick Start

The persistence system is automatically initialized when the server starts:

```bash
npm start
# or
node proxy-server-sdk.js
```

You'll see initialization messages:
```
🔄 Initializing persistence system...
📂 Loaded server state from server-state.json
📊 State Summary: {...}
✅ Persistence system ready
```

## 📋 What Gets Persisted

### **📊 Account Data**
- Cached account information
- Account numbers and hash values
- Last updated timestamps

### **📋 Order Tracking**
- **Active Orders** - Currently open orders for cleanup
- **Completed Orders** - Historical order records
- Order metadata (symbol, type, timestamps)

### **🔐 Session Data**
- Refresh tokens and access tokens
- Token expiry information
- Last refresh timestamps

### **⚠️ Error Tracking**
- Recent error history (last 50 errors)
- Error counts and statistics
- Detailed error information for debugging

### **⚙️ Configuration**
- Server settings and preferences
- Port and environment configuration
- Version information

### **📈 Metadata**
- Restart count
- Total uptime
- Creation and save timestamps

## 🔧 Management APIs

### **📊 View State**
```bash
curl "http://localhost:3001/api/v1/admin/state"
```

**Response:**
```json
{
  "summary": {
    "accounts": { "cachedCount": 2, "lastUpdated": "2026-02-14T20:15:03.718Z" },
    "orders": { "activeCount": 1, "completedCount": 5, "lastCleanup": "2026-02-14T20:15:03.718Z" },
    "session": { "hasRefreshToken": true, "lastRefresh": "2026-02-14T20:15:03.718Z" },
    "errors": { "recentCount": 3, "totalCount": 15 },
    "metadata": { "restartCount": 3, "createdAt": "2026-02-14T20:15:03.713Z" }
  },
  "activeOrders": [
    { "id": "1005436975606", "symbol": "THAR", "type": "LIMIT", "status": "active" }
  ],
  "recentErrors": [
    { "message": "Order not found", "timestamp": "2026-02-14T20:15:03.718Z" }
  ]
}
```

### **💾 Save State**
```bash
curl -X POST "http://localhost:3001/api/v1/admin/state/save"
```

### **🧹 Cleanup Old Data**
```bash
curl -X POST "http://localhost:3001/api/v1/admin/state/cleanup"
```

### **🔄 Reset State**
```bash
curl -X POST "http://localhost:3001/api/v1/admin/state/reset"
```

## 🔄 Automatic Tracking

### **Order Placement**
When orders are placed, they're automatically tracked:
```javascript
// Server logs show:
📋 Order tracked for persistence: 1005436975606
```

### **Order Cancellation**
When orders are canceled, they're moved to completed:
```javascript
// Server logs show:
📋 Order marked as completed in persistence: 1005436975606
```

### **Error Logging**
All API errors are automatically logged:
```javascript
// Server logs show:
📋 Error logged to persistence: "Order not found"
```

## 📁 File Structure

### **Primary Storage**
- `server-state.json` - Main persistence file
- `server-state.backup.json` - Automatic backup

### **State Format**
```json
{
  "accounts": {
    "cached": {},
    "lastUpdated": "2026-02-14T20:15:03.718Z",
    "accountNumbers": []
  },
  "orders": {
    "active": [],
    "completed": [],
    "lastCleanup": "2026-02-14T20:15:03.718Z"
  },
  "session": {
    "refreshToken": null,
    "accessToken": null,
    "tokenExpiry": null,
    "lastRefresh": "2026-02-14T20:15:03.718Z"
  },
  "config": {
    "port": 3001,
    "environment": "development",
    "version": "1.0.0"
  },
  "errors": {
    "recent": [],
    "errorCount": 0,
    "lastError": null
  },
  "metadata": {
    "createdAt": "2026-02-14T20:15:03.713Z",
    "lastSaved": "2026-02-14T20:15:03.718Z",
    "restartCount": 0,
    "totalUptime": 0
  }
}
```

## 🛠️ Advanced Usage

### **Manual State Inspection**
```bash
# View raw state file
cat server-state.json | jq .

# Check state summary
curl "http://localhost:3001/api/v1/admin/state" | jq .summary
```

### **Order Cleanup**
The system automatically tracks orders for cleanup:
- Active orders are monitored
- Completed orders are archived
- Old data (older than 1 week) is automatically cleaned

### **Error Analysis**
Recent errors are kept for debugging:
```bash
# Get last 10 errors
curl "http://localhost:3001/api/v1/admin/state" | jq .recentErrors[:10]
```

## 🔒 Security Considerations

### **Sensitive Data**
- **No credentials stored** - Tokens are in memory only
- **Hashed account numbers** - Only partial hashes stored
- **No API keys** - Environment variables used directly

### **File Permissions**
- State files are created with default permissions
- Consider restricting access in production
- Backup files created automatically

## 🚨 Troubleshooting

### **State File Corruption**
If the main state file is corrupted:
1. System automatically tries backup file
2. If backup fails, starts with fresh state
3. No data loss - just fresh start

### **Memory Issues**
Large state files are automatically cleaned:
- Orders older than 1 week are removed
- Errors older than 1 week are removed
- State is compacted on each save

### **Performance Impact**
- Minimal overhead - async operations
- State saved only when data changes
- Background cleanup operations

## 📊 Monitoring

### **Health Check**
```bash
curl "http://localhost:3001/health"
```

### **State Health**
```bash
curl "http://localhost:3001/api/v1/admin/state" | jq .summary
```

### **Restart Tracking**
```bash
# Check restart count
curl "http://localhost:3001/api/v1/admin/state" | jq .metadata.restartCount
```

## 🔄 Backup & Recovery

### **Automatic Backups**
- Backup created before each save
- Backup file: `server-state.backup.json`
- Automatic recovery on corruption

### **Manual Backup**
```bash
cp server-state.json server-state.manual-backup.json
```

### **State Reset**
```bash
# Complete reset (fresh start)
curl -X POST "http://localhost:3001/api/v1/admin/state/reset"
```

## 🎯 Best Practices

### **Development**
- Use state tracking for debugging
- Monitor error logs regularly
- Check active orders before restart

### **Production**
- Monitor restart count
- Regular cleanup operations
- Backup state files periodically

### **Testing**
- Reset state between test runs
- Verify order tracking works
- Test error logging functionality

## 📚 Integration

The persistence system integrates seamlessly with:
- **Order placement** - Automatic tracking
- **Order cancellation** - Status updates
- **Error handling** - Automatic logging
- **Account management** - Data caching

## 🔄 Future Enhancements

Planned improvements:
- **Data encryption** - Encrypt sensitive state data
- **Remote storage** - Cloud-based persistence
- **Real-time sync** - Multi-instance synchronization
- **Advanced analytics** - Usage statistics and insights

---

**The persistence system ensures your proxy server maintains state across restarts, providing reliable operation and valuable debugging capabilities!** 🗄️✨
