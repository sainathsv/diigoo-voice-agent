#!/usr/bin/env bash
# JENAI SaaS: create the server that runs app.jenai.in.
#
# Run this once, from a machine logged in to AWS account 198146918643:
#   bash deploy/01-provision.sh
#
# It makes: an IAM role for the server, a t4g.medium in Mumbai, a fixed public
# address, and the DNS record app.jenai.in. The database (jenai-prod-db) and
# the two security groups already exist. Nothing here touches the live voice
# server at 65.1.4.82.
set -euo pipefail

R=ap-south-1
ACCT=198146918643
ZONE=Z02997962Y4RNQCZX4O3N          # jenai.in
HOST=app.jenai.in
APP_SG=sg-0b8fad254c197fae1          # jenai-app-sg (80, 443 open)
SUBNET=subnet-00cb20f90aa5ff902      # ap-south-1a, same VPC as the database
AMI=ami-004fef5ef59c0175f            # Ubuntu 24.04 LTS, arm64
SIZE=t4g.medium
KEY_NAME=${KEY_NAME:-jenai-saas}
WORK=$(mktemp -d)

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

say "1. The server's own permissions (certificates, alerts, AI in Mumbai, secrets, logs)"
cat > "$WORK/trust.json" <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
cat > "$WORK/policy.json" <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"CertsViaDns","Effect":"Allow","Action":["route53:ChangeResourceRecordSets","route53:ListResourceRecordSets"],"Resource":"arn:aws:route53:::hostedzone/${ZONE}"},
 {"Sid":"CertsLookup","Effect":"Allow","Action":["route53:ListHostedZones","route53:GetChange"],"Resource":"*"},
 {"Sid":"Alerts","Effect":"Allow","Action":["sns:Publish"],"Resource":["arn:aws:sns:${R}:${ACCT}:jenai-alerts"]},
 {"Sid":"AiModels","Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream","bedrock:Converse","bedrock:ConverseStream"],"Resource":["arn:aws:bedrock:${R}::foundation-model/*","arn:aws:bedrock:${R}:${ACCT}:inference-profile/*"]},
 {"Sid":"Secrets","Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParameters"],"Resource":"arn:aws:ssm:${R}:${ACCT}:parameter/jenai/prod/*"},
 {"Sid":"Logs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogStreams","logs:PutRetentionPolicy"],"Resource":"arn:aws:logs:${R}:${ACCT}:log-group:/jenai/*"}
]}
JSON
aws iam create-role --role-name jenai-saas-role --assume-role-policy-document "file://$WORK/trust.json" \
  --description "JENAI SaaS app server" >/dev/null 2>&1 || echo "   role already there"
aws iam put-role-policy --role-name jenai-saas-role --policy-name jenai-saas --policy-document "file://$WORK/policy.json"
aws iam attach-role-policy --role-name jenai-saas-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name jenai-saas-profile >/dev/null 2>&1 || true
aws iam add-role-to-instance-profile --instance-profile-name jenai-saas-profile --role-name jenai-saas-role 2>/dev/null || true
echo "   waiting for the role to become usable"
sleep 15

say "2. A key to log in with (kept at ~/.ssh/${KEY_NAME}.pem)"
if [ ! -f "$HOME/.ssh/${KEY_NAME}.pem" ]; then
  aws ec2 create-key-pair --region $R --key-name "$KEY_NAME" --query KeyMaterial --output text > "$HOME/.ssh/${KEY_NAME}.pem"
  chmod 600 "$HOME/.ssh/${KEY_NAME}.pem"
  echo "   new key saved"
else
  echo "   using the key you already have"
fi

say "3. The server"
EXISTING=$(aws ec2 describe-instances --region $R --filters Name=tag:Name,Values=jenai-saas Name=instance-state-name,Values=pending,running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")
if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
  ID=$EXISTING
  echo "   already running: $ID"
else
  ID=$(aws ec2 run-instances --region $R \
    --image-id $AMI --instance-type $SIZE --key-name "$KEY_NAME" \
    --security-group-ids $APP_SG --subnet-id $SUBNET \
    --iam-instance-profile Name=jenai-saas-profile \
    --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":40,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":false}}]' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=jenai-saas},{Key=app,Value=jenai},{Key=Backup,Value=jenai-daily}]' \
    --query 'Instances[0].InstanceId' --output text)
  echo "   launched: $ID"
fi
aws ec2 modify-instance-attribute --region $R --instance-id "$ID" --disable-api-termination
aws ec2 modify-instance-attribute --region $R --instance-id "$ID" --disable-api-stop
aws ec2 wait instance-running --region $R --instance-ids "$ID"

say "4. A fixed public address"
ALLOC=$(aws ec2 describe-addresses --region $R --filters Name=tag:Name,Values=jenai-saas --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$ALLOC" = "None" ] || [ -z "$ALLOC" ]; then
  ALLOC=$(aws ec2 allocate-address --region $R --domain vpc \
    --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=jenai-saas},{Key=app,Value=jenai}]' \
    --query AllocationId --output text)
fi
aws ec2 associate-address --region $R --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
IP=$(aws ec2 describe-addresses --region $R --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
echo "   $IP"

say "5. DNS: $HOST points at the server"
cat > "$WORK/dns.json" <<JSON
{"Comment":"JENAI SaaS","Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"${HOST}","Type":"A","TTL":60,"ResourceRecords":[{"Value":"${IP}"}]}}]}
JSON
aws route53 change-resource-record-sets --hosted-zone-id $ZONE --change-batch "file://$WORK/dns.json" \
  --query 'ChangeInfo.Status' --output text

say "Done."
cat <<TXT

  Server     $ID  ($SIZE, Mumbai)
  Address    $IP  ->  https://$HOST
  Log in     ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@$IP
  Database   jenai-prod-db (private, reachable only from this server)

Next: bash deploy/02-setup-server.sh $IP
TXT
rm -rf "$WORK"
