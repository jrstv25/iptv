require('dotenv').config();
const fetch = require('node-fetch').default;
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 9697;
const LOG_FILE = path.join(__dirname, 'logs', 'server.log');

const cache = {};
const CACHE_DURATION = 24 * 60 * 60 * 1000;
const validRegions = ['usa', 'ca', 'mx', 'uk', 'au', 'cl', 'fr', 'it', 'za', 'nz', 'ee'];

if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'));
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    console.log(line.trim());
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getChannelM3u(channelId, apikey, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(`https://tv-addon.debridio.com/${apikey}/meta/tv/${channelId}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            log(`Channel ${channelId} fetch failed (attempt ${attempt}/${retries}): ${err.message}`);
            if (attempt < retries) await delay(500 * attempt);
        }
    }
    return null;
}

async function buildM3U(catalog, apikey) {
    const channels = catalog.metas;
    const m3uEntries = ["#EXTM3U"];

    const results = await Promise.all(
        channels.map(ch => getChannelM3u(ch.id, apikey))
    );

    results.forEach(m3u => {
        if (!m3u || !m3u.meta || !m3u.meta.streams || !m3u.meta.streams[0]) return;
        m3uEntries.push(
            `#EXTINF:-1 tvg-id="${m3u.meta.tvgId}" tvg-logo="${m3u.meta.logo}" group-title="${m3u.meta.genres?.[0] || ''}",${m3u.meta.name}\n${m3u.meta.streams[0].url}`
        );
    });

    return m3uEntries.join("\n");
}

async function fetchAndCache(apikey, region) {
    log(`Refreshing playlist for ${region}...`);
    try {
        const catalogRes = await fetch(`https://tv-addon.debridio.com/${apikey}/catalog/tv/${region}.json`);
        if (!catalogRes.ok) throw new Error("Failed to fetch catalog");
        const catalogData = await catalogRes.json();

        const m3u = await buildM3U(catalogData, apikey);
        cache[`${apikey}_${region}`] = { m3u, timestamp: Date.now() };
        log(`Playlist for ${region} updated successfully.`);
    } catch (err) {
        log(`Error refreshing ${region}: ${err.message}`);
    }
}

app.get("/playlist", async (req, res) => {
    const { apikey, region, refresh } = req.query;

    if (!apikey || !region || !validRegions.includes(region)) {
        return res.status(400).send(`Error: Missing or invalid parameters. Valid regions: ${validRegions.join(', ')}`);
    }

    const cacheKey = `${apikey}_${region}`;
    const now = Date.now();

    if (!refresh && cache[cacheKey] && (now - cache[cacheKey].timestamp < CACHE_DURATION)) {
        return res.type("text/plain").send(cache[cacheKey].m3u);
    }

    await fetchAndCache(apikey, region);
    if (cache[cacheKey]) {
        res.type("text/plain").send(cache[cacheKey].m3u);
    } else {
        res.status(500).send("Unable to generate playlist");
    }
});

function scheduleDailyRefresh() {
    const now = new Date();
    const millisTillMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5) - now;

    setTimeout(() => {
        log("Starting daily playlist refresh...");
        Object.keys(cache).forEach(key => {
            const [apikey, region] = key.split("_");
            fetchAndCache(apikey, region);
        });
        setInterval(() => {
            log("Running daily playlist refresh...");
            Object.keys(cache).forEach(key => {
                const [apikey, region] = key.split("_");
                fetchAndCache(apikey, region);
            });
        }, 24 * 60 * 60 * 1000);
    }, millisTillMidnight);
}

scheduleDailyRefresh();

app.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
});
