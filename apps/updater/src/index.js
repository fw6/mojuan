/**
 * mojuan 更新通道（Cloudflare Worker）。
 *
 * 两个客户端从四个出口取东西：
 *   GET /latest.json       桌面端 tauri-plugin-updater 的更新清单（没有可发布版本时回 204）
 *   GET /android.json      Android OTA 的清单：版本 + APK 的 sha256 + 下载地址（同上）
 *   GET /dl/<tag>/<文件名>  该版本制品的下载代理
 *   GET /schema.json       源文档的 JSON Schema（编辑器补全与源仓库提交时校验用）
 *
 * 清单里 tauri-action 写的制品地址是 GitHub 的 API 资产地址，普通 GET 取回的是资产元数据
 * 而不是文件（GitHub 只在 Accept: octet-stream 时回字节），所以清单与制品都由这个 Worker
 * 取回、换成自己的地址后对外提供。
 *
 * schema.json 是随仓库入的产物（由 mojuan-core 的 Rust 结构体生成），不经 GitHub，也不需要凭据。
 */

import schema from "./schema.json" with { type: "json" };

const GITHUB_API = "https://api.github.com";
const MANIFEST_ASSET = "latest.json";
const ANDROID_MANIFEST_ASSET = "android.json";

/** 通道自己的配置问题（凭据不对），与上游故障分开报。 */
class ConfigError extends Error {}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method !== "GET") {
            return text(405, "只支持 GET");
        }
        if (url.pathname === "/") {
            return text(
                200,
                "mojuan 更新通道：/latest.json 取桌面清单，/android.json 取 Android 清单，/dl/<tag>/<文件名> 取制品，/schema.json 取源文档的 JSON Schema",
            );
        }
        // 源文档的 Schema 与更新无关，不需要 GITHUB_TOKEN
        if (url.pathname === "/schema.json") {
            return json(schema);
        }
        const isManifest = url.pathname === "/latest.json";
        const isAndroid = url.pathname === "/android.json";
        const isDownload = url.pathname.startsWith("/dl/");
        if (!isManifest && !isAndroid && !isDownload) {
            return text(404, "未知路径");
        }
        if (!env.GITHUB_TOKEN) {
            return text(500, "Worker 未配置 GITHUB_TOKEN secret");
        }
        try {
            if (isManifest) {
                return await latestManifest(env, url.origin);
            }
            if (isAndroid) {
                return await androidManifest(env, url.origin);
            }
            return await downloadAsset(request, env, url);
        } catch (e) {
            if (e instanceof ConfigError) {
                return text(500, `更新通道配置有误：${e.message}`);
            }
            return text(502, `更新通道故障：${e.message}`);
        }
    },
};

/**
 * 最新已发布版本；草稿与预发布版本被 GitHub 的 latest 排除在外。
 * 没有已发布版本时返回 null。
 */
async function latestRelease(env) {
    const release = await githubJson(
        env,
        `${GITHUB_API}/repos/${env.GITHUB_REPO}/releases/latest`,
        { allow404: true },
    );
    if (release) {
        return release;
    }
    // 404 有两种成因：仓库里确实还没有已发布版本，或者这个 token 看不到仓库。
    // 后者会让更新通道永远安静地回「没有更新」，所以多问一次仓库本身，把它
    // 变成看得见的错误。
    const repo = await githubJson(env, `${GITHUB_API}/repos/${env.GITHUB_REPO}`, {
        allow404: true,
    });
    if (!repo) {
        throw new ConfigError(
            `GITHUB_TOKEN 看不到 ${env.GITHUB_REPO}，检查 PAT 是否选中了这个仓库、Contents 是否为 Read-only`,
        );
    }
    return null;
}

/** 读该版本里的一个清单资产；版本或资产不存在时返回 null。 */
async function readManifestAsset(env, release, name) {
    if (!release) {
        return null;
    }
    const asset = release.assets.find((a) => a.name === name);
    return asset ? JSON.parse(await githubText(env, asset.url)) : null;
}

/** 桌面端 tauri-plugin-updater 的更新清单。 */
async function latestManifest(env, origin) {
    const release = await latestRelease(env);
    const manifest = await readManifestAsset(env, release, MANIFEST_ASSET);
    if (!manifest) {
        return new Response(null, { status: 204 });
    }
    return json(buildManifest(manifest, release, origin));
}

/**
 * Android OTA 的清单：版本、APK 的 sha256、APK 的下载地址。
 *
 * `android.json` 资产由 release.yml 的 Android 作业生成（APK 一起传进同一个
 * release）。桌面端升级器不认识这个出口，两条通道互不影响。
 */
async function androidManifest(env, origin) {
    const release = await latestRelease(env);
    const manifest = await readManifestAsset(env, release, ANDROID_MANIFEST_ASSET);
    if (!manifest) {
        return new Response(null, { status: 204 });
    }
    return json(buildAndroidManifest(manifest, release, origin));
}

/**
 * 把 tauri-action 生成的清单里指向 GitHub API 的制品地址换成这个 Worker 自己的
 * 下载路径：GitHub 的资产地址需要登录才能取，客户端没有凭据。
 */
export function buildManifest(manifest, release, origin) {
    const platforms = {};
    for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
        platforms[platform] = {
            ...entry,
            url: rewriteAssetUrl(entry, release, origin, platform),
        };
    }
    return { ...manifest, platforms };
}

/** Android 清单的改写：只换 APK 地址，version 与 sha256 原样透传。 */
export function buildAndroidManifest(manifest, release, origin) {
    return {
        ...manifest,
        url: rewriteAssetUrl(manifest, release, origin, "android"),
    };
}

/**
 * 清单条目里指向 GitHub 的制品地址 → 这个 Worker 的下载路径。
 *
 * 地址可能是 GitHub 的 API 资产地址、Releases 直链，也可能是制品文件名本身
 * （`android.json` 由 CI 生成，那时 APK 还没有对外地址）。
 */
function rewriteAssetUrl(entry, release, origin, label) {
    const byId = new Map(release.assets.map((a) => [String(a.id), a.name]));
    const names = new Set(release.assets.map((a) => a.name));
    const ref = assetRefFromUrl(entry.url);
    const name = ref?.id ? byId.get(ref.id) : (ref?.name ?? entry.url);
    if (!name || !names.has(name)) {
        throw new Error(
            `清单里的 ${label} 指向 ${release.tag_name} 中不存在的制品：${entry.url}`,
        );
    }
    return `${origin}/dl/${release.tag_name}/${encodeURIComponent(name)}`;
}

/** 从制品地址里认出制品：tauri-action 写的是 API 资产地址，也可能是 Releases 直链。 */
export function assetRefFromUrl(url) {
    if (typeof url !== "string") {
        return null;
    }
    const api = /\/releases\/assets\/(\d+)$/.exec(url);
    if (api) {
        return { id: api[1] };
    }
    const direct = /\/releases\/download\/[^/]+\/([^/?#]+)$/.exec(url);
    if (direct) {
        return { name: decodeURIComponent(direct[1]) };
    }
    return null;
}

/** 制品下载代理：转发客户端的 Range，把上游的响应体直接交给客户端。 */
async function downloadAsset(request, env, url) {
    const rest = url.pathname.slice("/dl/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
        return text(404, "路径要写成 /dl/<tag>/<文件名>");
    }
    const tag = decodeURIComponent(rest.slice(0, slash));
    const name = decodeURIComponent(rest.slice(slash + 1));

    const release = await githubJson(
        env,
        `${GITHUB_API}/repos/${env.GITHUB_REPO}/releases/tags/${encodeURIComponent(tag)}`,
        { allow404: true },
    );
    if (!release) {
        return text(404, `没有 ${tag} 这个版本`);
    }
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) {
        return text(404, `${tag} 里没有 ${name}`);
    }

    const headers = assetHeaders(env);
    const range = request.headers.get("Range");
    if (range) {
        headers.Range = range;
    }
    const upstream = await fetch(asset.url, { headers, redirect: "follow" });
    if (upstream.status !== 200 && upstream.status !== 206) {
        return text(502, `上游返回 ${upstream.status}`);
    }
    const out = new Headers();
    for (const h of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
    ]) {
        const v = upstream.headers.get(h);
        if (v) {
            out.set(h, v);
        }
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
}

function githubHeaders(env) {
    return {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mojuan",
    };
}

/**
 * 取资产内容的请求头。GitHub 只在 Accept 为 octet-stream 时回文件本身，用 JSON
 * 的 Accept 去取资产地址拿到的是资产元数据（没有 version / platforms）。
 */
function assetHeaders(env) {
    const headers = githubHeaders(env);
    headers.Accept = "application/octet-stream";
    return headers;
}

async function githubJson(env, apiUrl, { allow404 = false } = {}) {
    const res = await fetch(apiUrl, { headers: githubHeaders(env) });
    if (res.status === 404 && allow404) {
        return null;
    }
    if (!res.ok) {
        throw new Error(`GitHub ${res.status}：${await githubMessage(res)}`);
    }
    return res.json();
}

async function githubText(env, apiUrl) {
    const res = await fetch(apiUrl, { headers: assetHeaders(env) });
    if (!res.ok) {
        throw new Error(`GitHub ${res.status}：${await githubMessage(res)}`);
    }
    return res.text();
}

/** GitHub 的错误说明（401/403 时是排查凭据问题最直接的线索）。 */
async function githubMessage(res) {
    const body = await res.text();
    try {
        return JSON.parse(body).message ?? body.slice(0, 200);
    } catch {
        return body.slice(0, 200);
    }
}

function json(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
}

function text(status, message) {
    return new Response(message, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}
