#!/bin/env node

import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { URL } from "node:url";

function help() {
    console.log(`Usage: ${process.title} ${path.relative(process.cwd(), process.argv[1])} [folder name]`);
    console.log("Populates an album folder with data from the internet");
    console.log(`Folder name should be in format "arist name - album name"`);
    console.log("Folder can contain source.txt to automatically use yt-dlp to download songs");
    console.log("   source.txt should be a playlist url or a list of sources");
    console.log(`   source should be in format "[<artist name> - ]<song name> <url> [startTime] [endTime]"`);
    console.log("Folder can contain mp3 files to automatically download lyrics");
    process.exit(0);
}

async function processFolderPath(folderPath) {
    {
        const folderStat = await fs.stat(folderPath, { throwIfNoEntry: false });
        if (!folderStat) {
            console.error(`Folder "${folderPath}" doesn't exist`);
            help();
        } else if (!folderStat.isDirectory()) {
            console.error(`Folder "${folderPath}" isn't a folder`);
            help();
        }
    }

    const [albumArtist, albumName] = path.parse(folderPath).name.split(" - ").map(i => i.trim());
    if (!albumArtist || !albumName) {
        console.error(`Folder name doesnt look like "artist name - album name"`);
        help();
    }

    return {
        albumArtist,
        albumName,
    };
}

async function duckduckgoImages(query) {
    async function getVqd() {
        const res = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
        const html = await res.text();

        const vqdMatch = html.match(/vqd=["']([^"']+)["']/);
        if (!vqdMatch) throw new Error("No vqd token found");
        return vqdMatch[1];
    }

    const res = await fetch(
        `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${await getVqd()}`,
        {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json"
            }
        }
    );

    const data = await res.json();
    return data.results;
}

async function downloadFile(url, destination) {
    try {
        await pipeline(
            Readable.fromWeb((await fetch(url)).body),
            createWriteStream(destination + ".tmp")
        );
    } catch (e) {
        await fs.unlink(destination + ".tmp");
        throw e;
    }
    await fs.rename(destination + ".tmp", destination);
}

function shellEscape(arg) {
    if (!/[\s"'\\$`!&|;<>()[\]{}*?]/.test(arg))
        return arg; // Only quote if it contains whitespace or shell-special characters
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function spawnEasy(args) {
    args = args.map(String);
    console.log(args.map(shellEscape).join(" "));
    let stdout = "";
    let stderr = "";
    const child = spawn(args[0], args.slice(1));
    child.stdout.on("data", data => {
        stdout += data.toString();
        process.stdout.write(data);
    });
    child.stderr.on("data", data => {
        stderr += data.toString();
        process.stderr.write(data);
    });
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code !== 0) {
                const err = new Error(`Child exited with code ${code}`);
                return reject(err);
            }
            if (signal) {
                const err = new Error(`Child exited with signal ${signal}`);
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

async function downloadThumbnail({ destinationFolder, albumArtist, albumName }) {
    const searchResults = await duckduckgoImages(`Album Cover - "${albumArtist}" - "${albumName}"`);
    const [imageWidth, imageHeight, imageUrl] = await (async () => {
        for (const result of searchResults) {
            if (result.width < 500 || result.height < 500)
                continue;
            if (result.width !== result.height)
                continue;
            return [result.width, result.height, result.image];
        }
        throw new Error("Couldn't find thumbnail");
    })();
    const tmpDownloadPath = path.join(destinationFolder, "thumbnail.tmp");
    try {
        await downloadFile(imageUrl, tmpDownloadPath);
        if (path.parse(imageUrl).ext !== ".jpg" || imageWidth != 500 || imageHeight != 500) {
            await spawnEasy([
                "magick",
                path.join(destinationFolder, "thumbnail.tmp"),
                "-resize", "500x500",
                path.join(destinationFolder, "thumbnail.jpg")
            ]);
        }
    } finally {
        if (await fileExists(tmpDownloadPath))
            await fs.unlink(tmpDownloadPath);
    }
}

async function fileExists(fileName) {
    const stat = await fs.stat(fileName, { throwIfNoEntry: false });
    if (!stat)
        return false;
    if (!stat.isFile())
        throw new Error(`${fileName} is not a file`);
    return true;
}

function parseTimestamp(str) {
    if (str === undefined)
        return undefined;
    return str // 12:23:45
        .split(":") // ["12", "23", "45"]
        .toReversed() // ["45", "23", "12"]
        .map((s, index) => Number(s) * (60 ** index)) // [45 * 60^2, 23 * 60, 12]
        .reduce((a, b) => a + b, 0); // 45 * 60^2 + 23 * 60 + 12
}

function formatTimestamp(timestamp) {
    if (timestamp === undefined)
        return undefined;
    if (timestamp === 0)
        return "0";
    const hours = Math.floor(timestamp / 3600);
    const minutes = Math.floor((timestamp % 3600) / 60);
    const seconds = Math.floor(timestamp % 60);
    return [hours, minutes, seconds]
        .map(i => String(i).padStart(2, "0"))
        .join(":")
        .replace(/^(00:)+/g, "");
}

function sanitizeUrl(str) {
    const url = new URL(str);
    // Remove tracking params
    for (const param of [
        "si", "feature", "pp", "start_radio",
        "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    ]) url.searchParams.delete(param);
    // Remove www.
    if (url.hostname.startsWith("www."))
        url.hostname = url.hostname.slice("www.".length);
    url.host = url.hostname;
    // Remove music.
    if (url.hostname.startsWith("music.") && url.toString().indexOf("playlist") === -1)
        url.hostname = url.hostname.slice("music.".length);
    url.host = url.hostname;
    // Shorten youtube urls
    if (url.hostname === "youtube.com" && url.pathname === "/watch") {
        url.hostname = "youtu.be";
        url.pathname = "/" + url.searchParams.get("v");
        url.searchParams.delete("v")
    }
    return url.toString();
}

async function processSourceTxt({ albumArtist, folderPath }) {
    const sourcePath = path.join(folderPath, "source.txt");
    if (!await fileExists(sourcePath))
        return;
    const lines = (await fs.readFile(sourcePath, "utf-8"))
        .split("\n")
        .map(i => i.trim())
        .filter(i => i);
    const errors = [];
    /**
     * @type {{ index: number, artist: string, name: string, url: string, filename: string, startTime: number | undefined, endTime: number | undefined }[]}
     */
    let sources = [];
    if (lines.length === 1 && lines[0].indexOf("://") < 10) { // heuristic
        const playlistSource = lines[0];
        const playlistData = JSON.parse((await spawnEasy(["yt-dlp", "--flat-playlist", "-J", "--", sanitizeUrl(playlistSource)])).stdout);
        // Remove leading artist name and index
        for (const entry of playlistData.entries)
            entry.title = entry.title.replace(/^(?:\w+\s*-+\s*|[\d\(\)\[\]]+\s+)+/, "");
        // Format entries
        sources = playlistData.entries.map(({ title, url }, index) => ({
            index, artist: albumArtist, name: title,
            url: sanitizeUrl(url)
        }));
        sources.unshift({ comment: playlistSource });
    } else {
        let index = 0;
        sources = lines.map(source => {
            if (source.startsWith("#"))
                return { comment: source.slice(1).trim() };
            const regex = /^(?:(.+?) - )?(.+?) ?(\w+:[^ ]+) ?([\d:]+)? ?([\d:]+)?$/;
            const match = source.match(regex);
            if (!match) {
                errors.push(`Source line "${source}" did not match regex ${regex}`);
                return { comment: "Invalid line" };
            }
            const [_, songArtist, songName, url, startTimeRaw, endTimeRaw] = match;
            if (songArtist && songArtist.indexOf(" - ") !== -1) {
                errors.push(`Source "${songArtist} - ${songName}" has an extra " - "`);
                return { comment: "Invalid line" };
            }
            const startTime = parseTimestamp(startTimeRaw);
            const endTime = parseTimestamp(endTimeRaw);
            if (endTime <= startTime) {
                errors.push(`Source "${songArtist} - ${songName}" endTime ${endTimeRaw} is before startTime ${startTimeRaw}`);
                return { comment: "Invalid line " };
            }
            return {
                index: index++, artist: songArtist ?? albumArtist, name: songName,
                startTime, endTime,
                url: sanitizeUrl(url)
            };
        });
        // Add end times
        sources.forEach((source, index) => {
            if (source.startTime === undefined)
                return;
            const next = sources.find((s, i) => i > index && s.comment === undefined);
            if (next === undefined)
                return;
            if (next.startTime === undefined) {
                errors.push(`Song "${source.artist} - ${source.name}" has a startTime but "${next.artist} - ${next.name}" doesn't`);
                return;
            }
            source.endTime = next.startTime;
        });
    }
    // Check for duplicates and illegal titles
    const titles = new Set();
    for (const { artist, name, comment } of sources) {
        if (comment !== undefined)
            continue;
        let title = `${artist} - ${name}`;
        if (title.startsWith(".")) {
            errors.push(`Song "${title}" starts with a period`);
            title = title.slice(1);
        }
        if (!title.match(/^[\p{L}\p{M}\p{N} \(\)_\-+',\.:!?~*]+$/u)) {
            errors.push(`Song "${title}" has invalid chars, must contain only alphanumeric chars, accents or the symbols " ()_-+',.:!?~*"`);
        }
        if (titles.has(title))
            errors.push(`Song "${title}" is a duplicate`);
        titles.add(title);
    }
    // Write to source file
    await fs.writeFile(sourcePath, sources.map(({ comment, artist, name, url, startTime, endTime }) => {
        if (comment !== undefined)
            return `# ${comment}`;
        let out = `${artist} - ${name} ${url}`;
        if (startTime !== undefined) {
            out += " " + formatTimestamp(startTime);
            if (endTime !== undefined)
                out += " " + formatTimestamp(endTime);
        }
        return out;
    }).join("\n") + "\n");
    // Add filenames
    sources.forEach(source => {
        if (source.comment)
            return;
        source.filename = `${String(source.index + 1).padStart(2, "0")} ${source.artist} - ${source.name}.mp3`;
    });
    // Throw errors
    if (sources.length === 0)
        errors.push("No sources given");
    if (errors.length) {
        console.error(errors.join("\n"));
        process.exit(1);
    }
    return sources;
}

function sanitizeFilename(name, maxLength = 64) {
    if (!name) return "unnamed";

    name = name.normalize("NFKC"); // Unicode normalize
    name = [...name].filter(c => c.charCodeAt(0) >= 32).join(""); // Remove control characters
    name = name.replace(/\s+/g, " ").trim(); // Collapse whitespace
    name = name.replace(/[. ]+$/, ""); // Windows forbids trailing dots/spaces

    // Replace illegal filename characters
    name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, char =>
        "%" + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")
    );

    // Avoid Windows reserved names
    const windowsReserved = new Set([
        "CON", "PRN", "AUX", "NUL",
        ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
        ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
    ]);
    const stem = name.split(".")[0].toUpperCase();
    if (windowsReserved.has(stem)) name = "_" + name;

    // Limit length while preserving uniqueness
    if (name.length > maxLength) {
        const hash = [...name]
            .reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 0)
            .toString(16);
        name = name.slice(0, maxLength - hash.length - 1) + "_" + hash;
    }

    return name;
}

let tempFiles = [];
process.on("beforeExit", async (code) => {
    if (tempFiles.length > 0) {
        const promises = tempFiles.map(i => fs.unlink(i));
        tempFiles = [];
        await Promise.allSettled(promises);
    }
    process.exit(code);
});
async function dowloadSource({ destination, url, startTime, endTime }) {
    if (startTime !== undefined) {
        const wholePath = sanitizeFilename(url) + ".tmp.mp3";
        if (!await fileExists(wholePath)) {
            tempFiles.push(wholePath);
            await spawnEasy([
                "yt-dlp",
                "-x",
                "--audio-format", "mp3",
                "--embed-metadata",
                "-o", wholePath,
                url
            ]);
        }
        await spawnEasy([
            "ffmpeg",
            "-i", wholePath,
            "-ss", startTime,
            ...(endTime === undefined ? [] : ["-to", endTime]),
            "-vn",
            "-c:a", "copy",
            "-map_metadata", "0",
            "-avoid_negative_ts", "make_zero",
            destination
        ]);
    } else {
        await spawnEasy([
            "yt-dlp",
            "-x",
            "--audio-format", "mp3",
            "--embed-metadata",
            "-o", destination,
            url
        ]);
    }
}

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

async function downloadLyrics(destination) {
    const query = (() => {
        const parsed = path.parse(destination);
        let out = parsed.name + parsed.ext;
        out = out.replace(/\.txt$/, "");
        out = out.replace(/^[\d ]+/, "");
        out = out.replace(/\s+/g, " ");
        out = out.trim();
        return out;
    })();
    const lyrics = await (async () => {
        const userAgent = `AureliaKuneKomp Lyric Downloader`
        const url = new URL("https://lrclib.net/api/search");
        url.searchParams.set("q", query);
        const res = await fetchGraceful(url, {
            headers: {
                "User-Agent": userAgent
            }
        });
        const tracks = await res.json();
        if (!tracks.length)
            return "No lyrics found";
        const track = tracks[0];
        let lyrics = track.syncedLyrics ?? track.plainLyrics ?? "No lyrics found";
        lyrics += "\n"
        lyrics = lyrics.replace(/[ \t\v\f]+/g, " ");
        lyrics = lyrics.replace(/[\r\n]+/g, "\n");
        return lyrics;
    })();
    await fs.writeFile(destination, lyrics);
}

if (process.argv.length !== 3)
    help();
const folderPath = process.argv[2];

const {
    albumArtist,
    albumName,
} = await processFolderPath(folderPath);

if (!await fileExists(path.join(folderPath, "thumbnail.jpg"))) {
    console.log("No thumbnail.jpg found, downloading from ddg");
    await downloadThumbnail({ destinationFolder: folderPath, albumArtist, albumName });
}

let sources = await processSourceTxt({ albumArtist, folderPath });
if (sources) {
    const existing = (await fs.readdir(folderPath))
        .filter(i => i.endsWith(".mp3"))
        .map(i => path.parse(i))
        .map(i => i.name + i.ext);
    const toRename = [];
    sources = sources.filter(({ filename, comment }) => {
        if (comment !== undefined)
            return false;
        const existingNoIndex = existing.find(i => filename.replace(/^\d+\s+/, "") === i.replace(/^\d+\s+/, ""));
        if (existingNoIndex) {
            if (existingNoIndex !== filename)
                toRename.push({ from: existingNoIndex, to: filename })
            return false;
        }
        return true;
    });
    for (let { from, to } of toRename) {
        from = path.join(folderPath, from);
        to = path.join(folderPath, to);
        console.log(`Moving ${from} to ${to}`);
        await fs.rename(from, to);
    }
    for (const { filename, url, startTime, endTime } of sources) {
        const destination = path.join(folderPath, filename);
        if (startTime !== undefined)
            console.log(`Downloading ${url} ${startTime}s - ${endTime}s to ${destination}`);
        else
            console.log(`Downloading ${url} to ${destination}`);
        await dowloadSource({ destination, url, startTime, endTime });
    }
}

const lyricPaths = (await fs.readdir(folderPath))
    .filter(i => i.endsWith(".mp3"))
    .map(i => i.replace(/\.mp3$/, ".txt"))
    .map(i => path.join(folderPath, i))
for (const lyricPath of lyricPaths) {
    if (await fileExists(lyricPath))
        continue;
    console.log(`Downloading lyrics ${lyricPath}`);
    await downloadLyrics(lyricPath);
}
