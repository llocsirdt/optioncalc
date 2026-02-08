# Create secret in AWS Secrets Manager
aws secretsmanager create-secret \
  --name "schwab-proxy-credentials" \
  --secret-string '{"api_key":"your-api-key","secret":"your-secret","access_token":"your-access-token"}' \
  --description "Schwab API credentials for proxy server"
