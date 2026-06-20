# Kubernetes deployment

Manifests to run the full Summer stack on any Kubernetes cluster (local kind/minikube,
or managed EKS/GKE/AKS). Four workloads:

| Workload | Image | Notes |
|---|---|---|
| `api` | `ghcr.io/<owner>/summer-api` | FastAPI; **2 replicas**, stateless, health-probed |
| `web` | `ghcr.io/<owner>/summer-web` | nginx serving the React build; proxies to `api:8000` |
| `postgres` | `pgvector/pgvector:pg16` | PVC-backed; vector + relational data |
| `neo4j` | `neo4j:5` | PVC-backed; the prerequisite graph |

Images are built and pushed by [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

## Deploy

```bash
# 1) create the real secret (do NOT use the template values in 00-config.yaml)
kubectl create secret generic summer-secrets \
  --from-literal=DATABASE_URL='postgresql+psycopg://summer:STRONGPW@postgres:5432/summer' \
  --from-literal=POSTGRES_USER=summer \
  --from-literal=POSTGRES_PASSWORD=STRONGPW \
  --from-literal=POSTGRES_DB=summer \
  --from-literal=NEO4J_PASSWORD=STRONGPW \
  --from-literal=NEO4J_AUTH='neo4j/STRONGPW' \
  --from-literal=SECRET_KEY="$(openssl rand -hex 32)" \
  --from-literal=OPENAI_API_KEY=sk-... \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...

# 2) apply the config + workloads (skip the Secret stanza in 00-config.yaml since
#    you created it above, or edit that file with real values instead of step 1)
kubectl apply -f k8s/00-config.yaml   # ConfigMap (and Secret template if you edited it)
kubectl apply -f k8s/10-postgres.yaml
kubectl apply -f k8s/20-neo4j.yaml
kubectl apply -f k8s/30-api.yaml
kubectl apply -f k8s/40-web.yaml
kubectl apply -f k8s/50-ingress.yaml

# 3) watch it come up
kubectl get pods -w
```

After the pods are Ready, build the graph + embedding indexes once (admin token):

```bash
kubectl exec deploy/api -- python -c "print('hit POST /campus/graph/sync and /campus/embeddings/sync')"
```

## Notes / production hardening
- **Secrets:** never commit real values. Use `kubectl create secret`, a sealed-secret,
  or an external secrets operator. `00-config.yaml`'s Secret block is a template only.
- **Scaling:** `api` and `web` are stateless and set to 2 replicas — add an
  `HorizontalPodAutoscaler` to scale on CPU. `postgres`/`neo4j` are single-replica
  with PVCs (use a managed DB / StatefulSet for real HA).
- **Probes:** `api` and `web` have readiness/liveness probes so rollouts are safe.
- **Ingress:** assumes an ingress controller (e.g. ingress-nginx). For cloud, swap in
  a managed LB / TLS via cert-manager.
