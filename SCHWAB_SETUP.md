# Schwab API Integration Setup Guide

## Browser-Compatible Implementation

This implementation uses a browser-compatible approach that doesn't require Node.js. You'll need to manually obtain your access and refresh tokens from Schwab and enter them in the web interface.

## Prerequisites

1. **Schwab Brokerage Account** - Free, no minimum balance required
2. **Schwab Developer Account** - Free signup required

## Setup Steps

### 1. Enable thinkorswim
1. Log into your Schwab account
2. Go to: https://client.schwab.com/app/trade/tradingtools
3. Enable thinkorswim (required for API access)

### 2. Create Schwab Developer Account
1. Go to: https://developer.schwab.com
2. Click "Sign Up" and create a free developer account
3. Log into your developer account

### 3. Create an App
1. Go to: https://developer.schwab.com/dashboard/apps
2. Click "Create New App"
3. Fill in the required information:
   - **App Name**: "Option Calculator" (or your choice)
   - **Description**: "Options calculator with live data"
   - **Callback URL**: `http://localhost:3000/callback`
   - **Scopes**: Select "Market Data" and "Trading"
4. Submit and wait for approval (typically 1-3 days)

### 4. Get Your Tokens
Once your app is approved, you'll need to obtain access and refresh tokens:

#### Option A: Using Postman (Recommended)
1. Use the Schwab API Postman collection from their documentation
2. Follow the OAuth 2.0 flow to get your tokens
3. Copy the `access_token` and `refresh_token`

#### Option B: Using browser and curl commands

**Step 1: Get Authorization Code**
Open this URL in your browser (replace YOUR_APP_KEY with your actual app key):
```
https://api.schwabapi.com/v1/oauth/authorize?client_id=YOUR_APP_KEY&redirect_uri=https://llocsirdt.github.io/optioncalc/&response_type=code
```

This will redirect you to Schwab's login page. After logging in and authorizing the app, you'll be redirected to:
```
https://llocsirdt.github.io/optioncalc/?code=YOUR_AUTHORIZATION_CODE
```

Copy the `code` parameter from the URL.

**Step 2: Exchange Authorization Code for Tokens**
```bash
curl --compressed --output - -X POST "https://api.schwabapi.com/v1/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
  -d "grant_type=authorization_code&redirect_uri=https://llocsirdt.github.io/optioncalc/&code=YOUR_AUTHORIZATION_CODE"
```

**Alternative: Request uncompressed JSON**
```bash
curl -H "Accept: application/json" -H "Accept-Encoding: identity" --output - -X POST "https://api.schwabapi.com/v1/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
  -d "grant_type=authorization_code&redirect_uri=https://llocsirdt.github.io/optioncalc/&code=YOUR_AUTHORIZATION_CODE"
```

**Alternative: Save to file**
```bash
curl --output tokens.json -X POST "https://api.schwabapi.com/v1/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
  -d "grant_type=authorization_code&redirect_uri=https://llocsirdt.github.io/optioncalc/&code=YOUR_AUTHORIZATION_CODE"
```

**Then inspect the tokens:**
```bash
cat tokens.json
```

### 5. Configure the Web Application
1. Open the options calculator in your browser
2. In the Schwab API section, enter:
   - **Access Token**: Your access token from step 4
   - **Refresh Token**: Your refresh token from step 4
3. Click "Authenticate" to connect

## Features

Once connected, you'll have access to:

- **Real-time quotes** for underlying symbols
- **Live options chains** with bid/ask prices
- **Market hours** information

## Usage

1. Enter your Schwab API tokens in the authentication section
2. Click "Authenticate" to connect
3. Enter a symbol (e.g., SPY) in the symbol field
4. Click "Start Live Data" to begin real-time updates
5. The underlying price and options chain will update every 5 seconds
6. Use the live data to inform your options strategy calculations

## Token Management

- **Tokens are stored** in browser localStorage for convenience
- **Access tokens expire** after 30 minutes
- **Refresh tokens expire** after 7 days
- **Re-authentication required** when tokens expire

## Troubleshooting

### "Not Connected" Status
- Verify your tokens are valid and not expired
- Check that you've entered both access and refresh tokens
- Ensure your Schwab app is approved (status: "Ready for Use")

### "Error" Status
- Check browser console for specific error messages
- Verify tokens are copied correctly (no extra spaces)
- Ensure your Schwab account has thinkorswim enabled

### No Data Showing
- Verify the symbol is valid and tradable
- Check if market is open (some data unavailable during off-hours)
- Ensure you have the required permissions in your Schwab app

### Token Expired
- Tokens expire automatically for security
- Use the OAuth flow again to get new tokens
- Update the tokens in the web interface

## OAuth Troubleshooting

### "Resource not found" Error
- **Cause**: Using POST request instead of GET for authorization
- **Fix**: Use the browser URL method shown in Option B above
- **Correct URL**: `https://api.schwabapi.com/v1/oauth/authorize?client_id=YOUR_APP_KEY&redirect_uri=https://llocsirdt.github.io/optioncalc/&response_type=code`

### "invalid_client" Error
- **Cause**: Not using Basic Authentication for client credentials
- **Fix**: Use `-u "client_id:client_secret"` flag instead of including credentials in form data
- **Example**: `-u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET"`

### "Invalid redirect_uri" Error
- **Cause**: Redirect URI doesn't match what's configured in your Schwab app
- **Fix**: Ensure your app is configured with `https://llocsirdt.github.io/optioncalc/` exactly
- **Note**: The URI must match exactly (including https:// and trailing slash)

### "Invalid grant" Error
- **Cause**: Authorization code expired or already used
- **Fix**: Get a new authorization code by going through the browser flow again
- **Note**: Authorization codes expire quickly (usually 5-10 minutes)

### "App not approved" Error
- **Cause**: Your Schwab app hasn't been approved yet
- **Fix**: Wait for approval (typically 1-3 business days)
- **Status**: Check your app status in the Schwab developer dashboard

## Security Notes

- **Never share your tokens** with anyone
- **Tokens are stored locally** in your browser only
- **Clear browser data** to remove stored tokens
- **Use secure connections** (HTTPS) when obtaining tokens

## API Limits

- Rate limits apply to all API calls
- Live data updates every 5 seconds to respect rate limits
- Consider implementing caching for production use

## Support

- Schwab Developer Documentation: https://developer.schwab.com
- OAuth 2.0 Documentation: Available in Schwab developer portal

## Alternative: Node.js Implementation

If you prefer a more automated setup, you can:
1. Set up a Node.js backend server
2. Use the `schwab-client-js` package
3. Implement the full OAuth flow
4. Proxy API calls through your server

This provides better security and automatic token refresh, but requires additional server setup.

---

## 🚀 AWS Elastic Beanstalk Deployment

### 📦 Creating Deployment Package

#### **Option 1: Full Script (Recommended)**
```bash
# Navigate to your project directory
cd /path/to/optioncalc

# Make executable and run
chmod +x create-deployment-package.sh
./create-deployment-package.sh
```

#### **Option 2: Quick Script (Recommended)** OR

```bash
# Navigate to your project directory
cd /path/to/optioncalc

# Make executable and run
chmod +x quick-zip.sh
./quick-zip.sh
```
