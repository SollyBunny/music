#!/bin/env node
import { createHash } from "crypto";
import fs from "node:fs/promises";

function sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function fetchGraceful(input, init) {
    while (true) {
        await sleep(100);
        const res = await fetch(input, init);
        if (res.code === 429)
            await sleep(Number(res.headers.get("Retry After")) * 1000);
        else
            return res;
    }
}

const userAgent = `AureliaKuneKomp Lyric Downloader`;

async function generateToken() {
    function verifyNonce(result, target) {
        if (result.length !== target.length) return false;
        for (let i = 0; i < result.length; i++) {
            if (result[i] > target[i]) return false;
            if (result[i] < target[i]) break;
        }
        return true;
    }

    function solveChallenge(prefix, targetHex) {
        const target = Buffer.from(targetHex, "hex");
        let nonce = 0;

        while (true) {
            const hashed = createHash("sha256")
                .update(`${prefix}${nonce}`)
                .digest();
            if (verifyNonce(hashed, target))
                return nonce.toString();
            nonce++;
        }
    }

    const token = await(async () => {
        const res = await fetchGraceful("https://lrclib.net/api/request-challenge", {
            method: "POST",
            headers: { "User-Agent": userAgent }
        });
        const { prefix, target } = await res.json();
        const nonce = solveChallenge(prefix, target);
        return `${prefix}:${nonce}`;
    })();

    return token;
}

async function downloadUri(uri) {
    if (uri.startsWith("https://") || uri.startsWith("https://")) {
        const res = await fetch(uri);
        return await res.text();
    } else if (uri.startsWith("file://")) {
        const path = decodeURIComponent(uri.slice("file://".length));
        return await fs.readFile(path, "utf-8");
    } else {
        return await fs.readFile(uri, "utf-8");
    }
}

async function parseLrc(uri) {
    // [id: ngidkd3g]
    // [ar: Fall Out Boy]
    // [al: American Beauty / American Psycho]
    // [ti: Centuries]
    // [au: Pete Wentz, Patrick Stump, Joe Trohman, Andy Hurley, Raja Kumari, Suzanne Vega, Jonathan Rotem, Michael J. Fonesca & Justin Tranter]
    // [length: 03: 48]
    // [hh:mm:ss] line1
    // [hh:mm:ss] line2
    const content = await downloadUri(uri);

    const meta = {};
    for (const [_, key, value] of content.matchAll(/\[(\w+):\s+(.+?)\]/gm))
        meta[key] = value;

    for (const key of ["ti", "ar", "al", "length"])
        if (!(key in meta))
            throw new Error(`Missing required key ${key}`);

    let plainLyrics = "";
    let syncedLyrics = "";
    for (const [_, time, line] of content.matchAll(/\[([:\d\.]+)\]\s*(.+?)\s*$/gm)) {
        plainLyrics += `${line}\n`;
        syncedLyrics += `[${time}]${line}\n`;
    }

    return {
        trackName: meta["ti"],
        artistName: meta["ar"],
        albumName: meta["al"],
        duration: meta["length"],
        plainLyrics,
        syncedLyrics,
    };
}

async function uploadLrc({ token, lrc }) {
    await fetchGraceful("https://lrclib.net/api/publish", {
        method: "POST",
        headers: {
            "User-Agent": userAgent,
            "X-Publish-Token": token,
        },
        body: JSON.stringify(lrc),
    });
}

function help() {
    console.log(`Usage: ${process.title} ${path.relative(process.cwd(), process.argv[1])} lrcfile.lrc [token]`);
    console.log("Uploads a .lrc file to lrclib.net");
    process.exit(0);
}

if (process.argv.length !== 4 && process.argv.length !== 3)
    help();

const lrcPath = process.argv[2];
const lrc = await parseLrc(lrcPath);
for (const key of ["trackName", "artistName", "albumName", "duration"])
    console.log(`${key}: ${lrc[key]}`);

const token = process.argv[3] ?? await generateToken();
console.log(`Token: ${token}`);

await uploadLrc({ token, lrc });
console.log("Done");
