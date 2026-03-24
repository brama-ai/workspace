#!/bin/bash
set -e

LOG_FILE="/Users/nmdimas/work/brama-workspace/setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "============================================="
echo "Starting Installation Pipeline in Agent Setup"
echo "============================================="

export SSH_AUTH_SOCK
export SSH_AGENT_PID
eval $(ssh-agent -s) > /dev/null
expect -c '
spawn ssh-add /Users/nmdimas/.ssh/ai_platform
expect "Enter passphrase"
send "1991Dimas\r"
expect eof
'

SERVER="root@46.62.135.86"

echo "1) Completely removing Docker from server..."
ssh -o StrictHostKeyChecking=no $SERVER "systemctl stop docker docker.socket containerd || true; apt-get purge -y docker-engine docker docker.io docker-ce docker-ce-cli docker-compose-plugin docker-ce-rootless-extras docker-buildx-plugin containerd.io || true; apt-get autoremove -y --purge || true; rm -rf /var/lib/docker /etc/docker /var/lib/containerd /etc/apt/keyrings/docker.gpg /etc/apt/sources.list.d/docker.list || true"

echo "2) Installing Rancher K3s on server..."
ssh -o StrictHostKeyChecking=no $SERVER "curl -sfL https://get.k3s.io | sh -"

echo "Waiting for K3s nodes to become ready..."
ssh -o StrictHostKeyChecking=no $SERVER "until k3s kubectl get node; do sleep 2; done"

echo "3) Building images locally..."
cd /Users/nmdimas/work/brama-workspace
make k8s-build

echo "4) Loading images into remote K3s..."
docker save brama-core:dev | ssh -o StrictHostKeyChecking=no $SERVER "k3s ctr images import -"
docker save agent-hello:dev | ssh -o StrictHostKeyChecking=no $SERVER "k3s ctr images import -"

echo "5) Fetching Kubeconfig..."
ssh -o StrictHostKeyChecking=no $SERVER "cat /etc/rancher/k3s/k3s.yaml" > /tmp/remote_k3s.yaml
sed -i '' 's/127.0.0.1/46.62.135.86/g' /tmp/remote_k3s.yaml
export KUBECONFIG=/tmp/remote_k3s.yaml

echo "6) Installing core according to instructions..."
kubectl create namespace brama || true

export APP_SECRET="fake-secret-xyz"
export EDGE_AUTH_JWT_SECRET="fake-secret-xyz"
export DATABASE_URL="postgresql://app:app@brama-postgresql:5432/ai_community_platform?serverVersion=16&charset=utf8"

kubectl create secret generic brama-core-secrets \
  --namespace brama \
  --from-literal=APP_SECRET="${APP_SECRET}" \
  --from-literal=EDGE_AUTH_JWT_SECRET="${EDGE_AUTH_JWT_SECRET}" \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --from-literal=LANGFUSE_PUBLIC_KEY="lf_pk_your_key" \
  --from-literal=LANGFUSE_SECRET_KEY="lf_sk_your_key" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Using k3s-dev values as base for remote dev deployment since it uses our built images..."
cp brama-core/deploy/charts/brama/values-k3s-dev.yaml values-remote.yaml

cat << 'EOF' >> values-remote.yaml
ingress:
  hosts:
    core: 46.62.135.86.nip.io
EOF

helm upgrade --install brama ./brama-core/deploy/charts/brama \
  --namespace brama \
  --create-namespace \
  -f values-remote.yaml \
  --wait \
  --timeout 15m

echo "============================================="
echo "Pipeline execution completed successfully"
echo "============================================="
