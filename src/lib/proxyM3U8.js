import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || 8080;
const web_server_url = process.env.PUBLIC_URL || `http://${host}:${port}`;

async function tryFetchWithHeaders(url, headerSet, retryCount = 0) {
  const maxRetries = 3;
  
  try {
    const response = await axios(url, {
      headers: headerSet,
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: function (status) {
        return status < 500;
      },
    });
    return response;
  } catch (err) {
    if (err.response?.status === 403 && retryCount < maxRetries) {
      console.log(`Retry ${retryCount + 1} for URL:`, url);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      return tryFetchWithHeaders(url, headerSet, retryCount + 1);
    }
    throw err;
  }
}

export default async function proxyM3U8(url, headers, res) {
  if (!url) {
    res.writeHead(400);
    res.end("URL parameter is required");
    return;
  }
  
  // Extract domain from URL for referer
  const urlObj = new URL(url);
  const origin = `${urlObj.protocol}//${urlObj.host}`;
  
  // Try multiple header combinations
  const headerSets = [
    // First attempt: Anime streaming specific
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Connection': 'keep-alive',
      'Referer': 'https://aniwatch.to/',
      'Origin': 'https://aniwatch.to',
      'Sec-Ch-Ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      ...headers,
    },
    // Second attempt: Generic streaming
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
      'Referer': origin,
      'Origin': origin,
      ...headers,
    },
    // Third attempt: Minimal headers
    {
      'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16',
      'Accept': '*/*',
      ...headers,
    }
  ];
  
  let req = null;
  let lastError = null;
  
  for (let i = 0; i < headerSets.length; i++) {
    try {
      console.log(`Attempting request ${i + 1} for URL:`, url);
      req = await tryFetchWithHeaders(url, headerSets[i]);
      if (req && req.status < 400) {
        console.log(`Success with header set ${i + 1}`);
        break;
      }
    } catch (err) {
      lastError = err;
      console.log(`Header set ${i + 1} failed:`, err.response?.status || err.message);
      continue;
    }
  }
  
  if (!req && lastError) {
    console.error("M3U8 proxy error:", lastError.message);
    console.error("URL:", url);
    console.error("Status:", lastError.response?.status);
    console.error("Headers:", lastError.response?.headers);
    
    if (lastError.response?.status === 403) {
      res.writeHead(403);
      res.end(`Access denied (403) for URL: ${url}. The server may require specific headers or authentication. Try adding custom headers or check if the URL requires a referer.`);
    } else {
      res.writeHead(lastError.response?.status || 500);
      res.end("Failed to fetch M3U8: " + lastError.message);
    }
    return;
  }
  if (!req) {
    return;
  }
  
  // Check if we got a 403 response
  if (req.status === 403) {
    res.writeHead(403);
    res.end(`Access denied (403) for URL: ${url}. The server rejected the request. This may require specific authentication or headers.`);
    return;
  }
  const m3u8 = req.data
    .split("\n")
    //now it supports also proxying multi-audio streams
    // .filter((line) => !line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO"))
    .join("\n");
  if (m3u8.includes("RESOLUTION=")) {
    const lines = m3u8.split("\n");
    const newLines = [];
    for (const line of lines) {
      if (line.startsWith("#")) {
        if (line.startsWith("#EXT-X-KEY:")) {
          const regex = /https?:\/\/[^\""\s]+/g;
          const url = `${web_server_url}${
            "/ts-proxy?url=" +
            encodeURIComponent(regex.exec(line)?.[0] ?? "") +
            "&headers=" +
            encodeURIComponent(JSON.stringify(headers))
          }`;
          newLines.push(line.replace(regex, url));
        } else if (line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
          const regex = /https?:\/\/[^\""\s]+/g;
          const url = `${web_server_url}${
            "/m3u8-proxy?url=" +
            encodeURIComponent(regex.exec(line)?.[0] ?? "") +
            "&headers=" +
            encodeURIComponent(JSON.stringify(headers))
          }`;
          newLines.push(line.replace(regex, url));
        } else {
          newLines.push(line);
        }
      } else {
        const uri = new URL(line, url);
        newLines.push(
          `${
            web_server_url +
            "/m3u8-proxy?url=" +
            encodeURIComponent(uri.href) +
            "&headers=" +
            encodeURIComponent(JSON.stringify(headers))
          }`
        );
      }
    }

    [
      "Access-Control-Allow-Origin",
      "Access-Control-Allow-Methods",
      "Access-Control-Allow-Headers",
      "Access-Control-Max-Age",
      "Access-Control-Allow-Credentials",
      "Access-Control-Expose-Headers",
      "Access-Control-Request-Method",
      "Access-Control-Request-Headers",
      "Origin",
      "Vary",
      "Referer",
      "Server",
      "x-cache",
      "via",
      "x-amz-cf-pop",
      "x-amz-cf-id",
    ].map((header) => res.removeHeader(header));

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "*");

    res.end(newLines.join("\n"));
    return;
  } else {
    const lines = m3u8.split("\n");
    const newLines = [];
    for (const line of lines) {
      if (line.startsWith("#")) {
        if (line.startsWith("#EXT-X-KEY:")) {
          const regex = /https?:\/\/[^\""\s]+/g;
          const url = `${web_server_url}${
            "/ts-proxy?url=" +
            encodeURIComponent(regex.exec(line)?.[0] ?? "") +
            "&headers=" +
            encodeURIComponent(JSON.stringify(headers))
          }`;
          newLines.push(line.replace(regex, url));
        } else {
          newLines.push(line);
        }
      } else {
        const uri = new URL(line, url);

        newLines.push(
          `${web_server_url}${
            "/ts-proxy?url=" +
            encodeURIComponent(uri.href) +
            "&headers=" +
            encodeURIComponent(JSON.stringify(headers))
          }`
        );
      }
    }

    [
      "Access-Control-Allow-Origin",
      "Access-Control-Allow-Methods",
      "Access-Control-Allow-Headers",
      "Access-Control-Max-Age",
      "Access-Control-Allow-Credentials",
      "Access-Control-Expose-Headers",
      "Access-Control-Request-Method",
      "Access-Control-Request-Headers",
      "Origin",
      "Vary",
      "Referer",
      "Server",
      "x-cache",
      "via",
      "x-amz-cf-pop",
      "x-amz-cf-id",
    ].map((header) => res.removeHeader(header));

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "*");

    res.end(newLines.join("\n"));
    return;
  }
}
