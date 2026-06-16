# Dropkanzi — Contabo VPS Production Kurulum Rehberi

Bu doküman, Dropkanzi platformunu **Contabo VPS** üzerinde production ortamına almak için adım adım rehberdir.

Hedef: tek VPS, Docker Compose, Caddy (HTTPS), PostgreSQL (pgvector), Redis, BullMQ worker'lar.

---

## İçindekiler

1. [Mimari](#1-mimari)
2. [VPS seçimi](#2-vps-seçimi)
3. [İlk kurulum](#3-ilk-kurulum)
4. [Kodu sunucuya alma](#4-kodu-sunucuya-alma)
5. [Ortam değişkenleri (.env)](#5-ortam-değişkenleri-env)
6. [Domain ve TLS (Caddy)](#6-domain-ve-tls-caddy)
7. [İlk deploy](#7-ilk-deploy)
8. [Systemd ile otomatik başlatma](#8-systemd-ile-otomatik-başlatma)
9. [Doğrulama](#9-doğrulama)
10. [Yedekleme](#10-yedekleme)
11. [Güncelleme](#11-güncelleme)
12. [Sorun giderme](#12-sorun-giderme)

---

## 1. Mimari

```
Internet (80/443)
       │
       ▼
   ┌─────────┐
   │  Caddy  │  TLS + gzip
   └────┬────┘
        │
   /api/*  →  backend:3001
   /*      →  frontend:3000
        │
   postgres (pgvector) · redis · scraper · worker-pf · worker-pf-reprice
```

**Dışarı açık:** sadece `80`, `443`  
**Kapalı kalmalı:** `5432`, `6379`, `3000`, `3001`, `8001`

Prod compose: [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml)

---

## 2. VPS seçimi

| Öneri | Spec | Neden |
|-------|------|-------|
| **Minimum** | 4 vCPU, 8 GB RAM, 100 GB NVMe | Küçük ekip / test |
| **Önerilen** | 6–8 vCPU, 16 GB RAM, 200 GB NVMe | Scraper (SigLIP + sentence-transformers) bellek yoğun |

Contabo'da **Ubuntu 22.04** veya **24.04** seç.

---

## 3. İlk kurulum

VPS'e SSH ile bağlan:

```bash
ssh root@SUNUCU_IP
```

### 3.1 Sistem güncellemesi ve Docker

```bash
apt-get update && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw

curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
docker compose version
```

### 3.2 Firewall (UFW)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH — mümkünse sadece kendi IP'n
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

### 3.3 Veri dizinleri

```bash
mkdir -p /opt/dropkanzi /data/postgres /data/redis
chown -R 999:999 /data/postgres /data/redis 2>/dev/null || true
```

### 3.4 (Opsiyonel) deploy kullanıcısı

```bash
adduser deploy
usermod -aG docker deploy
# Sonra deploy kullanıcısıyla devam et
```

---

## 4. Kodu sunucuya alma

```bash
cd /opt/dropkanzi
git clone https://github.com/SENIN_ORG/Dropkanzi.git .
# veya lokalden rsync:
# rsync -avz --exclude node_modules --exclude .next ./Dropkanzi/ root@IP:/opt/dropkanzi/
```

Script izinleri:

```bash
chmod +x deploy/backup/pg-backup.sh
```

---

## 5. Ortam değişkenleri (.env)

Contabo'da **tek bir `.env` dosyası** yeterli (AWS SSM gerekmez).

```bash
cd /opt/dropkanzi
cp .env.example .env
nano .env
chmod 600 .env
```

### Zorunlu alanlar

```env
# PostgreSQL (docker network hostname: postgres)
POSTGRES_DB=pricehawk
POSTGRES_USER=admin
POSTGRES_PASSWORD=GUCLU_SIFRE_BURAYA
DATABASE_URL=postgresql://admin:GUCLU_SIFRE_BURAYA@postgres:5432/pricehawk

REDIS_URL=redis://redis:6379
SCRAPER_URL=http://scraper:8001
FORCE_PROXY=true

# Proxy (residential)
PROXY_USER=...
PROXY_PASS=...
PROXY_HOST=gw.dataimpulse.com
PROXY_PORT=823
PROXY_COUNTRY=us

# Uygulama URL
FRONTEND_URL=https://app.senindomain.com

# eBay OAuth (production)
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_REDIRECT_URI=RuName_string
EBAY_SANDBOX=false

# LLM (opsiyonel ama önerilir)
ANTHROPIC_API_KEY=sk-ant-...

# Product Finder
PF_SCAN_BUDGET_USD=2
# PF_API_KEY=  → frontend header göndermediği için ilk kurulumda BOŞ bırak
```

Tüm değişkenler için referans: [`.env.example`](../.env.example)

---

## 6. Domain ve TLS (Caddy)

### 6.1 DNS

Domain panelinde A kaydı:

```
app.senindomain.com  →  Contabo VPS IP
```

### 6.2 Caddyfile

[`deploy/Caddyfile`](../deploy/Caddyfile) içinde domain'i değiştir:

```caddy
app.senindomain.com {
    encode gzip

    handle /api/* {
        reverse_proxy backend:3001
    }

    handle {
        reverse_proxy frontend:3000
    }
}
```

### 6.3 eBay OAuth callback

eBay Developer Portal → RuName → Auth Accepted URL:

```
https://app.senindomain.com/api/auth/ebay/callback
```

---

## 7. İlk deploy

```bash
cd /opt/dropkanzi

# İlk build uzun sürer (scraper SigLIP model indirir, 10–20 dk)
docker compose -f deploy/docker-compose.prod.yml build
docker compose -f deploy/docker-compose.prod.yml up -d

# Durum
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs -f --tail=100
```

Backend container ayağa kalkınca `prisma migrate deploy` otomatik çalışır.

---

## 8. Systemd ile otomatik başlatma

```bash
cp /opt/dropkanzi/deploy/dropkanzi.service /etc/systemd/system/dropkanzi.service
systemctl daemon-reload
systemctl enable dropkanzi
systemctl start dropkanzi
systemctl status dropkanzi
```

Log:

```bash
journalctl -u dropkanzi -f
```

---

## 9. Doğrulama

```bash
curl -sS https://app.senindomain.com/api/health
# {"status":"ok"}

curl -sS https://app.senindomain.com/api/metrics
```

Tarayıcıda:

1. Ana sayfa açılmalı
2. Product Finder → Found sekmesi liste yüklemeli
3. Seller scan kuyruğa alınmalı (`POST /api/pf-scan`)

---

## 10. Yedekleme

### Günlük PostgreSQL dump (sunucuda)

```bash
mkdir -p /var/backups/dropkanzi
```

Cron (`crontab -e`):

```cron
0 3 * * * docker compose -f /opt/dropkanzi/deploy/docker-compose.prod.yml exec -T postgres pg_dump -U admin pricehawk | gzip > /var/backups/dropkanzi/pg-$(date +\%Y\%m\%d).sql.gz
```

Eski yedekleri sil (30 gün):

```cron
0 4 * * * find /var/backups/dropkanzi -name "pg-*.sql.gz" -mtime +30 -delete
```

### Restore testi

```bash
gunzip -c /var/backups/dropkanzi/pg-YYYYMMDD.sql.gz | \
  docker compose -f deploy/docker-compose.prod.yml exec -T postgres psql -U admin -d pricehawk
```

---

## 11. Güncelleme

```bash
cd /opt/dropkanzi
git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
# veya: systemctl restart dropkanzi
```

---

## 12. Sorun giderme

### Product Finder: `invalid input syntax for type double precision: "default"`

**Neden:** SQL parametre indeksi `tenantId` (`"default"`) ile çakışıyordu.  
**Çözüm:** Backend'i güncel kodla rebuild et:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build backend
```

### Caddy sertifika alamıyor

- DNS A kaydı VPS IP'ye işaret ediyor mu?
- UFW 80/443 açık mı?
- Caddyfile domain doğru mu?

```bash
docker compose -f deploy/docker-compose.prod.yml logs caddy
```

### Scraper build: `http.client` hatası

`scraper/http.py` dosyası `proxy_http.py` olarak yeniden adlandırıldı. Güncel kodu çek ve rebuild:

```bash
git pull
docker compose -f deploy/docker-compose.prod.yml build scraper --no-cache
```

### Scraper yavaş / OOM

```bash
free -h
docker compose -f deploy/docker-compose.prod.yml logs scraper
```

RAM yetersizse VPS planını yükselt (16 GB önerilir).

### PostgreSQL auth failed

`.env` içindeki `POSTGRES_PASSWORD` ile `DATABASE_URL` şifresi aynı olmalı. İlk kurulumda volume eski şifreyle oluşmuşsa volume'u sıfırla (veri gider):

```bash
docker compose -f deploy/docker-compose.prod.yml down
rm -rf /data/postgres/*
docker compose -f deploy/docker-compose.prod.yml up -d
```

### Container logları

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f backend
docker compose -f deploy/docker-compose.prod.yml logs -f worker-pf
docker compose -f deploy/docker-compose.prod.yml logs -f scraper
```

---

## Güvenlik checklist

- [ ] UFW: sadece 22 (kısıtlı), 80, 443
- [ ] PostgreSQL/Redis dışarıya kapalı
- [ ] `.env` chmod 600, git'e commit edilmedi
- [ ] `FORCE_PROXY=true`
- [ ] Güçlü `POSTGRES_PASSWORD`
- [ ] HTTPS aktif (Caddy)

---

## Dosya referansı

| Dosya | Görev |
|-------|-------|
| [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml) | Production stack |
| [`deploy/Caddyfile`](../deploy/Caddyfile) | Reverse proxy |
| [`deploy/dropkanzi.service`](../deploy/dropkanzi.service) | systemd unit |
| [`.env.example`](../.env.example) | Env referansı |

*Contabo VPS — tek sunucu production deployment.*
