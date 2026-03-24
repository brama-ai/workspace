#!/bin/bash
set -e
echo "[Server] Starting installation process on $(hostname)..."

echo "[Server] Removing Docker completely..."
systemctl stop docker docker.socket containerd || true
apt-get purge -y docker-engine docker docker.io docker-ce docker-ce-cli docker-compose-plugin docker-ce-rootless-extras docker-buildx-plugin containerd.io || true
apt-get autoremove -y --purge docker-engine docker docker.io docker-ce || true
rm -rf /var/lib/docker /etc/docker /var/lib/containerd
rm -f /etc/apt/keyrings/docker.gpg || true
rm -f /etc/apt/sources.list.d/docker.list || true

echo "[Server] Installing Rancher K3s..."
curl -sfL https://get.k3s.io | sh -

echo "[Server] Verifying K3s installation..."
until k3s kubectl get node; do
  echo "[Server] Waiting for nodes to be ready..."
  sleep 2
done

echo "[Server] Fetching kubeconfig for local use..."
cat /etc/rancher/k3s/k3s.yaml
