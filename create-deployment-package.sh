#!/bin/bash
# Create deployment ZIP for Elastic Beanstalk

echo "🚀 Creating Schwab Proxy deployment package..."

# Create deployment directory
DEPLOY_DIR="schwab-proxy-deploy"
rm -rf $DEPLOY_DIR
mkdir $DEPLOY_DIR

# Copy necessary files
echo "📁 Copying files..."
cp package.json $DEPLOY_DIR/
cp proxy-server.js $DEPLOY_DIR/

# Create .ebignore to exclude unnecessary files
echo "📝 Creating .ebignore..."
cat > $DEPLOY_DIR/.ebignore << EOF
.env
.env.local
.env.*.local
node_modules
.git
.gitignore
*.log
.DS_Store
README.md
.nyc_output
coverage
.nyc_output
.cache
dist
build
EOF

# Create .env.template (safe to include)
echo "📝 Creating .env.template..."
cat > $DEPLOY_DIR/.env.template << EOF
# Schwab API Configuration
SCHWAB_API_KEY=your-api-key-here
SCHWAB_SECRET=your-secret-here
SCHWAB_ACCESS_TOKEN=your-access-token-here
PORT=3001
EOF

# Create ZIP file
echo "📦 Creating ZIP file..."
cd $DEPLOY_DIR
zip -r ../schwab-proxy.zip . -x ".git/*" "node_modules/*" "*.log"
cd ..

# Clean up
rm -rf $DEPLOY_DIR

echo "✅ Deployment package created: schwab-proxy.zip"
echo "📊 Package contents:"
unzip -l schwab-proxy.zip

echo ""
echo "🚀 Ready for Elastic Beanstalk deployment!"
echo "📍 Upload schwab-proxy.zip to AWS Elastic Beanstalk"
