# PriceHawk — Amazon Price Tracker

## Hizli baslangic (Docker)

```powershell
cd c:\Dropkanzi
.\scripts\start.ps1
```

Veya elle:

```powershell
docker compose up -d --build
docker compose exec backend npx prisma migrate deploy
```

## Adresler

| Servis | URL |
|--------|-----|
| **Arayuz** | http://localhost:3000 |
| **API** | http://localhost:3001/api |
| **API (proxy)** | http://localhost:3000/api |
| **Scraper** | http://localhost:8001 |

## .env dosyalari

| Dosya | Kullanim |
|-------|----------|
| `.env` | Docker Compose — **ana config** (proxy, DB, Redis) |
| `backend/.env` | Yerel backend gelistirme (`localhost`) |
| `frontend/.env.local` | Yerel Next.js gelistirme |

Proxy (DataImpulse):

```
PROXY_USER=...
PROXY_PASS=...
PROXY_HOST=gw.dataimpulse.com
PROXY_PORT=823
PROXY_COUNTRY=us
```

## ASIN arama

- `B0D1XD1ZV3` gibi 10 karakter
- veya tam Amazon linki: `https://www.amazon.com/dp/B0D1XD1ZV3`

## Sorun giderme

```powershell
docker compose ps
docker compose logs scraper --tail 50
docker compose logs backend --tail 50
docker compose up -d --build
```
