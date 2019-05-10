#!/bin/bash
set -e
FABRIC_EXPLORER_TAG="876529727832.dkr.ecr.ap-northeast-2.amazonaws.com/payprotocol/explorer"

$(aws ecr get-login --no-include-email --region ap-northeast-2)

echo "Pushing PayProtocol explorer image..."
docker push $FABRIC_EXPLORER_TAG:latest
