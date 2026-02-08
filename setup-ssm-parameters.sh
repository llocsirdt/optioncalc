# Store secrets securely in AWS
aws ssm put-parameter \
  --name "/schwab-proxy/api-key" \
  --value "your-schwab-api-key" \
  --type "SecureString" \
  --description "Schwab API Key"

aws ssm put-parameter \
  --name "/schwab-proxy/secret" \
  --value "your-schwab-secret" \
  --type "SecureString" \
  --description "Schwab API Secret"

aws ssm put-parameter \
  --name "/schwab-proxy/access-token" \
  --value "your-access-token" \
  --type "SecureString" \
  --description "Schwab Access Token"
