#!/bin/bash
# Set environment variables securely

EB_ENVIRONMENT="your-environment-name"

aws elasticbeanstalk update-environment \
  --environment-name $EB_ENVIRONMENT \
  --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=SCHWAB_API_KEY,Value="your-api-key" \
  --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=SCHWAB_SECRET,Value="your-secret" \
  --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=SCHWAB_ACCESS_TOKEN,Value="your-access-token"
