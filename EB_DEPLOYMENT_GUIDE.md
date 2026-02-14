# 🚀 AWS Elastic Beanstalk Deployment Guide

## Overview

This guide covers deploying the Schwab Proxy Server with persistence to AWS Elastic Beanstalk, including handling multi-instance environments and state management.

## 🏗️ Architecture Considerations

### **Current Persistence System**
- **Local file storage** - Each instance maintains its own state
- **JSON-based persistence** - Simple, no database required
- **Automatic backup** - Local backup files
- **State tracking** - Orders, errors, session data

### **EB Environment Challenges**
- **Multi-instance scaling** - Multiple instances with separate state
- **Ephemeral storage** - Local storage lost on instance termination
- **Load balancing** - Requests distributed across instances
- **Deployments** - State may be lost during updates

## 🛠️ Deployment Options

### **Option 1: Single Instance (Recommended for Development)**
```yaml
# .ebextensions/single-instance.config
option_settings:
  aws:elasticbeanstalk:environment:
    EnvironmentType: SingleInstance
```

**Pros:**
- ✅ State persistence works as-is
- ✅ No complexity
- ✅ Lower cost

**Cons:**
- ❌ No high availability
- ❌ No auto-scaling

### **Option 2: Load Balanced with Local Persistence (Current)**
```yaml
# .ebextensions/load-balanced.config
option_settings:
  aws:elasticbeanstalk:environment:
    EnvironmentType: LoadBalanced
```

**Pros:**
- ✅ High availability
- ✅ Auto-scaling
- ✅ Works with existing code

**Cons:**
- ❌ State isolated per instance
- ❌ Inconsistent data across instances
- ❌ Orders may be lost on instance termination

### **Option 3: Load Balanced with S3 Persistence (Advanced)**
```yaml
# .ebextensions/s3-persistence.config
option_settings:
  aws:elasticbeanstalk:application:environment:
    S3_PERSISTENCE_BUCKET: your-app-state-bucket
    S3_PERSISTENCE_KEY: server-state.json
```

**Pros:**
- ✅ Shared state across instances
- ✅ Persistent storage
- ✅ High availability

**Cons:**
- ❌ Requires AWS SDK integration
- ❌ Additional complexity
- ❌ S3 costs

## 📁 Deployment Files

### **Required Files for EB Deployment**
```
optioncalc/
├── proxy-server-sdk.js          # Main application
├── persistence.js               # Original persistence
├── eb-persistence.js           # EB-compatible persistence
├── package.json                 # Dependencies
├── .ebextensions/
│   ├── persistence.config       # EB configuration
│   └── environment.config       # Environment variables
├── .env.production             # Production environment
└── EB_DEPLOYMENT_GUIDE.md      # This guide
```

### **Environment Variables**
```bash
# .env.production
NODE_ENV=production
PORT=8080
SCHWAB_CLIENT_ID=your_production_client_id
SCHWAB_CLIENT_SECRET=your_production_client_secret
SCHWAB_REFRESH_TOKEN=your_production_refresh_token
ACCOUNT_HASH=your_production_account_hash
```

## 🚀 Deployment Steps

### **Step 1: Prepare Application**
```bash
# Install dependencies
npm install --production

# Create EB extensions directory
mkdir -p .ebextensions

# Add deployment configuration
# (See .ebextensions/persistence.config)
```

### **Step 2: Configure EB Environment**
```bash
# Install EB CLI
pip install awsebcli

# Initialize EB application
eb init schwab-proxy-server

# Create environment
eb create production --instance-type t3.micro --single-instance
```

### **Step 3: Deploy Application**
```bash
# Deploy to EB
eb deploy production

# Monitor deployment
eb logs production
eb status production
```

### **Step 4: Configure Environment Variables**
```bash
# Set environment variables
eb setenv SCHWAB_CLIENT_ID=your_client_id
eb setenv SCHWAB_CLIENT_SECRET=your_client_secret
eb setenv SCHWAB_REFRESH_TOKEN=your_refresh_token
eb setenv ACCOUNT_HASH=your_account_hash
```

## 🔧 Configuration Options

### **Single Instance Deployment**
```yaml
# .ebextensions/single-instance.config
option_settings:
  aws:elasticbeanstalk:environment:
    EnvironmentType: SingleInstance
    InstanceType: t3.micro
    
  aws:elasticbeanstalk:application:environment:
    NODE_ENV: production
    PORT: 8080
    PERSISTENCE_MODE: local
```

### **Load Balanced Deployment**
```yaml
# .ebextensions/load-balanced.config
option_settings:
  aws:elasticbeanstalk:environment:
    EnvironmentType: LoadBalanced
    InstanceType: t3.micro
    MinInstances: 1
    MaxInstances: 3
    
  aws:elasticbeanstalk:application:environment:
    NODE_ENV: production
    PORT: 8080
    PERSISTENCE_MODE: local
    INSTANCE_AWARENESS: true
```

### **S3-Enhanced Deployment**
```yaml
# .ebextensions/s3-persistence.config
option_settings:
  aws:elasticbeanstalk:environment:
    EnvironmentType: LoadBalanced
    InstanceType: t3.micro
    
  aws:elasticbeanstalk:application:environment:
    NODE_ENV: production
    PORT: 8080
    PERSISTENCE_MODE: s3
    S3_BUCKET: your-app-state-bucket
    AWS_REGION: us-east-1
```

## 🔄 State Management Strategies

### **Strategy 1: Local Persistence (Current)**
```javascript
// Works as-is, but with limitations
const persistence = require('./persistence.js');
```

**Behavior:**
- Each instance has independent state
- Orders tracked per instance
- State lost on instance termination
- Inconsistent data across instances

### **Strategy 2: Instance-Aware Persistence**
```javascript
// Use eb-persistence.js for instance tracking
const EBPersistenceManager = require('./eb-persistence.js');
const persistence = new EBPersistenceManager();
```

**Behavior:**
- Instance ID tracking
- Environment awareness
- Better debugging
- Still local storage

### **Strategy 3: S3 Shared Persistence**
```javascript
// Requires AWS SDK integration
const S3PersistenceManager = require('./s3-persistence.js');
const persistence = new S3PersistenceManager();
```

**Behavior:**
- Shared state across instances
- Persistent storage
- Synchronization overhead
- Higher complexity

## 📊 Monitoring and Debugging

### **EB Health Monitoring**
```bash
# Check environment health
eb health production

# View application logs
eb logs production --all

# SSH into instance
eb ssh production
```

### **State Monitoring**
```bash
# Check persistence state
curl "http://your-app.elasticbeanstalk.com/api/v1/admin/state"

# Monitor active orders
curl "http://your-app.elasticbeanstalk.com/api/v1/admin/state" | jq .activeOrders

# Check instance information
curl "http://your-app.elasticbeanstalk.com/api/v1/admin/state" | jq .summary.metadata
```

### **Debugging Multi-Instance Issues**
```bash
# Check which instance handled request
curl "http://your-app.elasticbeanstalk.com/api/v1/admin/state" | jq .summary.metadata.instanceId

# Monitor instance-specific orders
curl "http://your-app.elasticbeanstalk.com/api/v1/admin/state" | jq .activeOrders[].instanceId
```

## ⚠️ Limitations and Considerations

### **Current System Limitations**
- **State isolation** - Each instance has separate state
- **Order tracking** - May be inconsistent across instances
- **Error logging** - Instance-specific only
- **Session data** - Not shared across instances

### **Production Considerations**
- **Data loss** - State lost on instance termination
- **Inconsistency** - Different instances have different data
- **Scaling issues** - New instances start with empty state
- **Deployment impact** - State lost during deployments

### **Recommended Solutions**
1. **Single instance** - For development/testing
2. **Database persistence** - For production (PostgreSQL/DynamoDB)
3. **Redis cache** - For session management
4. **S3 storage** - For shared state

## 🚦 Production Recommendations

### **For Development/Testing**
- ✅ **Single instance** deployment
- ✅ **Local persistence** works fine
- ✅ **No additional complexity**

### **For Production**
- ⚠️ **Load balanced** with awareness of limitations
- 🔄 **Consider database persistence** for critical data
- 🔄 **Use Redis** for session management
- 🔄 **Implement S3 backup** for important state

### **For High Availability**
- 🔄 **Database persistence** (PostgreSQL recommended)
- 🔄 **Redis cache** for fast access
- 🔄 **S3 backup** for durability
- 🔄 **Multi-AZ deployment**

## 🛠️ Advanced Configuration

### **Database Integration (Future)**
```javascript
// Example: Database persistence manager
class DatabasePersistenceManager {
  async saveState(state) {
    await this.db.collection('state').updateOne(
      { environment: process.env.ENVIRONMENT },
      { $set: { state, updatedAt: new Date() } },
      { upsert: true }
    );
  }
  
  async loadState() {
    const doc = await this.db.collection('state').findOne({
      environment: process.env.ENVIRONMENT
    });
    return doc?.state || this.getDefaultState();
  }
}
```

### **Redis Integration (Future)**
```javascript
// Example: Redis cache manager
class RedisPersistenceManager {
  async cacheOrder(order) {
    await this.redis.setex(
      `order:${order.id}`, 
      3600, // 1 hour TTL
      JSON.stringify(order)
    );
  }
  
  async getCachedOrder(orderId) {
    const cached = await this.redis.get(`order:${orderId}`);
    return cached ? JSON.parse(cached) : null;
  }
}
```

## 📚 Additional Resources

### **AWS Documentation**
- [Elastic Beanstalk Node.js Deployment](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/create_deploy_nodejs.html)
- [Environment Configuration](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environments-cfg.html)
- [Deploying with EB CLI](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/eb-cli3.html)

### **Best Practices**
- [EB Best Practices](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/using-features.bestpractices.html)
- [Node.js on EB](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/create_deploy_nodejs.html)
- [Environment Variables](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environment-properties.html)

---

## 🎯 Summary

### **Current System: Works with Limitations**
- ✅ **Single instance**: Perfect
- ⚠️ **Load balanced**: Works but with state isolation
- ❌ **Production critical**: Needs database persistence

### **Recommended Approach**
1. **Start with single instance** for development
2. **Test load balanced** with awareness of limitations
3. **Upgrade to database** for production critical applications

### **Next Steps**
1. Deploy to EB single instance
2. Test functionality
3. Evaluate persistence requirements
4. Upgrade to database persistence if needed

**The current persistence system will work in EB, but consider your scaling and data consistency requirements!** 🚀✨
