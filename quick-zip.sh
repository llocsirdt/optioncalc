#!/bin/bash
# Quick deployment ZIP creation

echo "📦 Creating deployment ZIP..."

# Create ZIP with only necessary files
zip -r schwab-proxy.zip \
  package.json \
  proxy-server.js \
  -x "*.git*" \
  -x "node_modules/*" \
  -x "*.log" \
  -x ".env*" \
  -x "*.DS_Store" \
  -x "README.md"

echo "✅ Created: schwab-proxy.zip"
echo "📊 Contents:"
unzip -l schwab-proxy.zip
