# Валідація локального k3s-рантайму (Rancher Desktop)

> **Мета**: Повторюваний процес перевірки, що платформа коректно запускається на Rancher Desktop k3s.
> **Кластер**: Rancher Desktop k3s (локальна машина)
> **Неймспейс**: `brama`
> **Helm release**: `brama`
> **Chart**: `brama-core/deploy/charts/brama`
> **Values**: `brama-core/deploy/charts/brama/values-k3s-dev.yaml`

---

## Передумови

| Інструмент | Перевірка | Встановлення |
|-----------|-----------|--------------|
| Rancher Desktop | Має бути запущений із увімкненим k3s | [rancherdesktop.io](https://rancherdesktop.io) |
| kubectl | `kubectl version --client` | Входить до складу Rancher Desktop, або `brew install kubectl` |
| helm v3 | `helm version` | `brew install helm` |
| Docker | `docker version` | Входить до складу Rancher Desktop |

Переконайтеся, що kubeconfig налаштований для Rancher Desktop:

```bash
kubectl config use-context rancher-desktop
kubectl config current-context
# Очікується: rancher-desktop
```

---

## Етап 1 — Валідація готовності кластера

### 1.1 Перевірити доступність кластера

```bash
kubectl get nodes
```

**Очікується**: Принаймні один вузол у стані `Ready`.

```
NAME                   STATUS   ROLES                  AGE   VERSION
rancher-desktop        Ready    control-plane,master   Xd    v1.XX.X+k3s1
```

**Якщо помилка**: Rancher Desktop не запущений або k3s не увімкнений. Відкрийте Rancher Desktop → Preferences → Kubernetes → увімкніть Kubernetes.

### 1.2 Перевірити наявність цільового неймспейсу

```bash
make k8s-ns
# або вручну:
kubectl get namespace brama 2>/dev/null || kubectl create namespace brama
```

**Очікується**: Неймспейс `brama` зі статусом `Active`.

### 1.3 Перевірити системні поди

```bash
kubectl get pods -A | grep -E "kube-system|cert-manager" | grep -v Running | grep -v Completed
```

**Очікується**: Відсутні поди зі станом `CrashLoopBackOff` або `Error` у системних неймспейсах.

---

## Етап 2 — Деплой платформи

Якщо платформа ще не розгорнута — виконайте повний сетап:

```bash
make k8s-setup
# Еквівалент: k8s-build + k8s-load + k8s-secrets + k8s-deploy
```

Або окремі кроки:

```bash
make k8s-build      # Зібрати Docker-образи локально
make k8s-load       # Завантажити образи в K3S через rdctl
make k8s-secrets    # Створити brama-core-secrets у неймспейсі brama
make k8s-deploy     # helm upgrade --install brama ...
```

---

## Етап 3 — Валідація інфраструктурного шару

Перевірте всі поди в неймспейсі `brama`:

```bash
kubectl get pods -n brama -o wide
```

**Очікується**: Всі поди у стані `Running` або `Completed`.

### 3.1 PostgreSQL

```bash
# Перевірити, що под запущений
kubectl get pods -n brama -l "app.kubernetes.io/name=postgresql"

# Перевірити підключення
kubectl exec -n brama -it \
  $(kubectl get pod -n brama -l "app.kubernetes.io/name=postgresql" -o jsonpath='{.items[0].metadata.name}') \
  -- psql -U app -d ai_community_platform -c "SELECT 1;"
```

**Очікується**: psql повертає `1` (запит виконано успішно).

**Якщо помилка**:
```bash
kubectl describe pod -n brama -l "app.kubernetes.io/name=postgresql"
kubectl logs -n brama -l "app.kubernetes.io/name=postgresql" --tail=50
```

### 3.2 Redis

```bash
# Перевірити, що под запущений
kubectl get pods -n brama -l "app.kubernetes.io/name=redis"

# Перевірити ping
kubectl exec -n brama -it \
  $(kubectl get pod -n brama -l "app.kubernetes.io/name=redis" -o jsonpath='{.items[0].metadata.name}') \
  -- redis-cli ping
```

**Очікується**: `PONG`.

**Якщо помилка**:
```bash
kubectl logs -n brama -l "app.kubernetes.io/name=redis" --tail=50
```

### 3.3 RabbitMQ

```bash
# Перевірити, що под запущений
kubectl get pods -n brama -l "app.kubernetes.io/name=rabbitmq"

# Перевірити статус кластера
kubectl exec -n brama -it \
  $(kubectl get pod -n brama -l "app.kubernetes.io/name=rabbitmq" -o jsonpath='{.items[0].metadata.name}') \
  -- rabbitmqctl status | grep "RabbitMQ"
```

**Очікується**: Рядок з версією RabbitMQ, без помилок.

**Якщо помилка**:
```bash
kubectl logs -n brama -l "app.kubernetes.io/name=rabbitmq" --tail=50
```

### 3.4 OpenSearch

> **Примітка**: OpenSearch вимкнений у `values-k3s-dev.yaml` (`opensearch.enabled: false`).
> Локально платформа використовує OpenSearch-контейнер із Docker Compose.
> Для k3s-валідації цей крок **пропускається**.

---

## Етап 4 — Валідація core-рантайму

### 4.1 Перевірити готовність core-поду

```bash
kubectl get pods -n brama -l "app.kubernetes.io/component=core"
```

**Очікується**: Статус поду `Running`, `READY 1/1`.

**Якщо под не готовий**:
```bash
kubectl describe pod -n brama -l "app.kubernetes.io/component=core"
kubectl logs -n brama -l "app.kubernetes.io/component=core" --tail=100
```

Найпоширеніша причина: відсутній Secret `brama-core-secrets` → виконайте `make k8s-secrets`.

### 4.2 Перевірити health-endpoint через exec

```bash
POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=core" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n brama $POD -- curl -sf http://localhost/health
```

**Очікується**:
```json
{"status":"ok","timestamp":"..."}
```

### 4.3 Перевірити доступ оператора через port-forward

```bash
kubectl port-forward -n brama svc/brama-core 8080:80 &

curl -sf http://localhost:8080/health
# або у браузері: http://core.localhost (потрібен запис у /etc/hosts)
```

**Очікується**: health-відповідь отримана.

Щоб додати локальний DNS-запис:
```bash
echo "127.0.0.1  core.localhost" | sudo tee -a /etc/hosts
```

Тоді перейдіть за адресою `http://core.localhost` (Traefik маршрутизує за заголовком `Host`).

---

## Етап 5 — Валідація референсного агента

Референсний агент у `values-k3s-dev.yaml` — **hello-agent** (`agents.hello.enabled: true`).

### 5.1 Перевірити готовність поду агента

```bash
kubectl get pods -n brama -l "app.kubernetes.io/component=agent-hello"
```

**Очікується**: Статус поду `Running`, `READY 1/1`.

### 5.2 Перевірити health-endpoint агента

```bash
AGENT_POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=agent-hello" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n brama $AGENT_POD -- curl -sf http://localhost/health
```

**Очікується**:
```json
{"status":"ok","service":"hello-agent","version":"0.1.0","timestamp":"..."}
```

### 5.3 Перевірити зв'язність core → агент

Kubernetes Discovery Provider читає Services з міткою `ai.platform.agent=true`.
Переконайтеся, що Service агента має потрібні мітки:

```bash
kubectl get svc -n brama -l "ai.platform.agent=true"
```

**Очікується**: Сервіс `brama-agent-hello` присутній у списку.

Перевірте, що core може дістатися агента через DNS кластера:

```bash
POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=core" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n brama $POD -- curl -sf \
  http://brama-agent-hello.brama.svc.cluster.local/health
```

**Очікується**: health-відповідь від hello-agent.

---

## Швидкий огляд статусу

```bash
make k8s-status
# Еквівалент:
kubectl get pods -n brama -o wide
kubectl get svc -n brama
kubectl get ingress -n brama
helm status brama -n brama
```

---

## Відомі проблеми та їх вирішення

| Проблема | Причина | Рішення |
|----------|---------|---------|
| `connection refused` при `kubectl get nodes` | Rancher Desktop не запущений | Запустіть Rancher Desktop, зачекайте ініціалізації k3s (~1 хв) |
| Под у стані `Pending` | Немає persistent volume | Rancher Desktop встановлює `local-path` provisioner — перевірте `kubectl get storageclass` |
| `ImagePullBackOff` | Образ не завантажено в k3s containerd | `make k8s-load` для імпорту образів через `rdctl` |
| `CrashLoopBackOff` у core | Відсутні секрети | `make k8s-secrets` для повторного створення `brama-core-secrets` |
| `exec format error` | Невідповідна архітектура образу | Збирайте образи на машині з тією ж архітектурою; Rancher Desktop на Apple Silicon потребує arm64-образів |
| Core недоступний за `core.localhost` | Відсутній запис у `/etc/hosts` | `echo "127.0.0.1 core.localhost" \| sudo tee -a /etc/hosts` |
| `helm: Kubernetes cluster unreachable` | Неправильний контекст kubectl | `kubectl config use-context rancher-desktop` |

---

## Мінімальна послідовність повторної валідації

Виконайте цю послідовність після будь-яких змін:

```bash
# 1. Перевірити контекст
kubectl config use-context rancher-desktop

# 2. Перевірити вузол кластера
kubectl get nodes

# 3. Перевірити всі поди brama
kubectl get pods -n brama

# 4. Health-check core
kubectl exec -n brama \
  $(kubectl get pod -n brama -l "app.kubernetes.io/component=core" \
    -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health

# 5. Health-check референсного агента
kubectl exec -n brama \
  $(kubectl get pod -n brama -l "app.kubernetes.io/component=agent-hello" \
    -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health

# 6. Перевірити мітки discovery у агентів
kubectl get svc -n brama -l "ai.platform.agent=true"
```

Усі шість кроків успішні = локальний k3s-рантайм підтверджено.
