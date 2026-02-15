#!/bin/bash

echo "🔍 Testing Option Chain Cache (Storage Mode)"
echo "=========================================="

# Check if server is running
if ! curl -s "http://localhost:3001/health" > /dev/null; then
    echo "❌ Server not running. Start with: npm run dev"
    exit 1
fi

echo "✅ Server is running"
echo ""

# Check cache status
echo "📊 Checking cache status..."
cache_status=$(curl -s "http://localhost:3001/api/v1/admin/chains")
cache_count=$(echo "$cache_status" | jq -r '.summary.cacheCount')

echo "Current cache count: $cache_count"

if [ "$cache_count" -gt 0 ]; then
    echo "✅ Cache has data"
    echo "Cached symbols: $(echo "$cache_status" | jq -r '.summary.cachedSymbols | join(", ")')"
else
    echo "⚠️  Cache is empty - making test request..."
fi

echo ""

# Test cache with SPY
echo "🧪 Testing cache storage with SPY..."
echo "Request 1 (fetch fresh + store):"
time curl -s "http://localhost:3001/api/v1/marketdata/chains?symbol=SPY&expirationDate=2024-02-16" > /dev/null

echo ""
echo "Request 2 (fetch fresh + update store):"
time curl -s "http://localhost:3001/api/v1/marketdata/chains?symbol=SPY&expirationDate=2024-02-16" > /dev/null

echo ""
echo "Note: Both requests should take similar time since we always fetch fresh data"
echo ""

# Final cache check
echo "📊 Final cache status..."
curl -s "http://localhost:3001/api/v1/admin/chains" | jq .

echo ""
echo "🎉 Cache storage test completed!"
echo ""
echo "💡 Cache Behavior:"
echo "  - Always fetches fresh data from Schwab API"
echo "  - Stores latest data in cache for backup/analysis"
echo "  - Never serves cached data to clients"
echo "  - Cache used only for storage purposes"
