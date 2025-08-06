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

async function buildM3U(catalog, apikey, filterSports = false) {
    const channels = catalog.metas;
    const m3uEntries = ["#EXTM3U"];

    const results = await Promise.all(
        channels.map(ch => getChannelM3u(ch.id, apikey))
    );

    results.forEach(m3u => {
        if (!m3u || !m3u.meta || !m3u.meta.streams || !m3u.meta.streams[0]) return;
        
        const genre = m3u.meta.genres?.[0] || '';
        
        // If filtering for sports, only include sports channels
        if (filterSports && genre.toLowerCase() !== 'sports') return;
        
        m3uEntries.push(
            `#EXTINF:-1 tvg-id="${m3u.meta.tvgId}" tvg-logo="${m3u.meta.logo}" group-title="${genre}",${m3u.meta.name}\n${m3u.meta.streams[0].url}`
        );
    });

    return m3uEntries.join("\n");
}

async function fetchAndCache(apikey, region, sportsOnly = false) {
    log(`Refreshing playlist for ${region}${sportsOnly ? ' (sports only)' : ''}...`);
    try {
        const catalogRes = await fetch(`https://tv-addon.debridio.com/${apikey}/catalog/tv/${region}.json`);
        if (!catalogRes.ok) {
            const errorText = await catalogRes.text();
            throw new Error(`Failed to fetch catalog: ${catalogRes.status} ${catalogRes.statusText} - ${errorText}`);
        }
        const catalogData = await catalogRes.json();

        const m3u = await buildM3U(catalogData, apikey, sportsOnly);
        const cacheKey = sportsOnly ? `${apikey}_${region}_sports` : `${apikey}_${region}`;
        cache[cacheKey] = { m3u, timestamp: Date.now() };
        log(`Playlist for ${region}${sportsOnly ? ' (sports only)' : ''} updated successfully.`);
    } catch (err) {
        log(`Error refreshing ${region}: ${err.message}`);
    }
}

async function buildMultiRegionSportsM3U(apikey, regions) {
    const m3uEntries = ["#EXTM3U"];
    const allChannels = new Map(); // Use Map to deduplicate by tvg-id
    
    for (const region of regions) {
        try {
            log(`Fetching sports channels for ${region}...`);
            const catalogRes = await fetch(`https://tv-addon.debridio.com/${apikey}/catalog/tv/${region}.json`);
            if (!catalogRes.ok) {
                log(`Failed to fetch catalog for ${region}: ${catalogRes.status}`);
                continue;
            }
            const catalogData = await catalogRes.json();
            const channels = catalogData.metas;

            const results = await Promise.all(
                channels.map(ch => getChannelM3u(ch.id, apikey))
            );

            results.forEach(m3u => {
                if (!m3u || !m3u.meta || !m3u.meta.streams || !m3u.meta.streams[0]) return;
                
                const genre = m3u.meta.genres?.[0] || '';
                if (genre.toLowerCase() !== 'sports') return;
                
                // Use tvg-id as key for deduplication, but prefer certain regions
                const channelId = m3u.meta.tvgId;
                const channelName = `${m3u.meta.name} (${region.toUpperCase()})`;
                
                if (!allChannels.has(channelId) || region === 'usa') {
                    allChannels.set(channelId, {
                        tvgId: m3u.meta.tvgId,
                        logo: m3u.meta.logo,
                        genre: genre,
                        name: channelName,
                        url: m3u.meta.streams[0].url,
                        region: region
                    });
                }
            });
        } catch (err) {
            log(`Error processing region ${region}: ${err.message}`);
        }
    }

    // Add all unique channels to M3U
    allChannels.forEach(channel => {
        m3uEntries.push(
            `#EXTINF:-1 tvg-id="${channel.tvgId}" tvg-logo="${channel.logo}" group-title="${channel.genre}",${channel.name}\n${channel.url}`
        );
    });

    return m3uEntries.join("\n");
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

app.get("/sports-playlist", async (req, res) => {
    const { apikey, regions, refresh } = req.query;

    if (!apikey) {
        return res.status(400).send("Error: Missing apikey parameter");
    }

    // Parse regions - can be comma-separated or single region
    let regionList;
    if (regions) {
        regionList = regions.split(',').map(r => r.trim()).filter(r => validRegions.includes(r));
        if (regionList.length === 0) {
            return res.status(400).send(`Error: No valid regions provided. Valid regions: ${validRegions.join(', ')}`);
        }
    } else {
        // Default to USA if no regions specified
        regionList = ['usa'];
    }

    const cacheKey = `${apikey}_sports_${regionList.join('_')}`;
    const now = Date.now();

    // Check cache first (unless refresh is requested)
    if (!refresh && cache[cacheKey] && (now - cache[cacheKey].timestamp < CACHE_DURATION)) {
        return res.type("text/plain").send(cache[cacheKey].m3u);
    }

    try {
        log(`Generating sports playlist for regions: ${regionList.join(', ')}`);
        const sportsM3u = await buildMultiRegionSportsM3U(apikey, regionList);
        
        // Cache the result
        cache[cacheKey] = { m3u: sportsM3u, timestamp: now };
        
        res.type("text/plain").send(sportsM3u);
    } catch (err) {
        log(`Error generating sports playlist: ${err.message}`);
        res.status(500).send("Unable to generate sports playlist");
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
