# Debrid.io → M3U Playlist Backend

This Node.js backend fetches TV channel data from Debrid.io and generates an M3U playlist for IPTV apps like TiviMate.

## Features
- In-memory caching (24 hours)
- Automatic daily refresh at midnight
- Retry logic for failed channel fetches
- Logging to file (`logs/server.log`)

## Run with Docker Compose
```bash
docker compose up -d
```

## Run with Docker
```bash
docker build -t debridio-m3u .
docker run -d   --name debridio-m3u   -p 9697:9697   -v $(pwd)/logs:/app/logs   debridio-m3u
```

## Playlist URL
```
http://YOUR-SERVER-IP:9697/playlist?apikey=YOUR_DEBRIDIO_KEY&region=usa
```
