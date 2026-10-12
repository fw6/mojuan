import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { assetRefFromUrl, buildAndroidManifest, buildManifest } from "../src/index.js";

const ORIGIN = "https://mojuan.example.workers.dev";
const REPO = "fw6/mojuan";
const REPO_URL = `https://api.github.com/repos/${REPO}`;
const LATEST_URL = `${REPO_URL}/releases/latest`;
const MANIFEST_URL = `${REPO_URL}/releases/assets/601292331`;
const ANDROID_MANIFEST_URL = `${REPO_URL}/releases/assets/601399999`;
const ANDROID_APK_URL = "https://api.github.com/repos/fw6/mojuan/releases/assets/601329752";

/** 固定装置取自 app-v1.4.0 的真实产物：清单、API 资产列表、各制品的 .sig 文件。 */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const manifest = JSON.parse(fixture("latest.json").toString("utf8"));
const android = JSON.parse(fixture("android.json").toString("utf8"));
const release = JSON.parse(fixture("release.json").toString("utf8"));

/**
 * 真实 v1.4.0 发布里还没有 android.json（Android 清单是后加的），测试按 CI 之后
 * 的样子补上这条资产；APK 本身已经在 fixture 里了。
 */
const releaseWithAndroid = {
    ...release,
    assets: [...release.assets, { id: 601399999, name: "android.json", url: ANDROID_MANIFEST_URL }],
};

const assetName = (url) => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));

/** 用固定的路由表顶替上游 GitHub API，测试里不发起真实请求。 */
function stubFetch(routes) {
    return async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const route = routes[url];
        if (!route) {
            throw new Error(`测试没有为 ${url} 准备响应`);
        }
        return route(init);
    };
}

async function callWorker(path, { routes = {}, env, method = "GET", headers } = {}) {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(routes);
    try {
        const request = new Request(`${ORIGIN}${path}`, { method, headers });
        return await worker.fetch(request, env ?? { GITHUB_TOKEN: "token", GITHUB_REPO: REPO });
    } finally {
        globalThis.fetch = original;
    }
}

const jsonRoute = (body) => () =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/**
 * 照 GitHub 的真实行为回资产内容：Accept 不是 octet-stream 时，资产地址给的是
 * 资产元数据而不是文件本身（漏了这一点会让清单解析出空 platforms）。
 */
const manifestRoute = (init) => {
    if (init?.headers?.Accept !== "application/octet-stream") {
        return new Response(JSON.stringify({ id: 601292331, name: "latest.json", size: 6116 }));
    }
    return new Response(JSON.stringify(manifest));
};

/** 与 latest.json 同理：Accept 不是 octet-stream 时，资产地址回的是资产元数据。 */
const androidManifestRoute = (init) => {
    if (init?.headers?.Accept !== "application/octet-stream") {
        return new Response(JSON.stringify({ id: 601399999, name: "android.json", size: 220 }));
    }
    return new Response(JSON.stringify(android));
};

test("每个平台的下载地址都改写到 Worker 自己，并指向该版本真实存在的制品", () => {
    const out = buildManifest(manifest, release, ORIGIN);
    const names = new Set(release.assets.map((a) => a.name));
    const platforms = Object.entries(out.platforms);

    assert.equal(platforms.length, Object.keys(manifest.platforms).length);
    assert.ok(platforms.length >= 8);
    for (const [platform, entry] of platforms) {
        assert.ok(entry.url.startsWith(`${ORIGIN}/dl/app-v1.4.0/`), `${platform}: ${entry.url}`);
        assert.ok(names.has(assetName(entry.url)), `${platform} 指向不存在的制品`);
        assert.ok(entry.signature.length > 0, `${platform} 缺签名`);
    }
    assert.equal(out.version, manifest.version);
    assert.equal(out.notes, manifest.notes);
    assert.equal(out.pub_date, manifest.pub_date);
});

test("平台与制品的对应关系没有串位", () => {
    const out = buildManifest(manifest, release, ORIGIN);
    const nameOf = (p) => assetName(out.platforms[p].url);

    assert.equal(nameOf("windows-x86_64"), "mojuan_1.4.0_x64_en-US.msi");
    assert.equal(nameOf("windows-x86_64-msi"), "mojuan_1.4.0_x64_en-US.msi");
    assert.equal(nameOf("windows-x86_64-nsis"), "mojuan_1.4.0_x64-setup.exe");
    assert.equal(nameOf("linux-x86_64"), "mojuan_1.4.0_amd64.AppImage");
    assert.equal(nameOf("linux-x86_64-deb"), "mojuan_1.4.0_amd64.deb");
    assert.equal(nameOf("linux-x86_64-rpm"), "mojuan-1.4.0-1.x86_64.rpm");
    assert.equal(nameOf("darwin-aarch64"), "mojuan_1.4.0_aarch64.app.tar.gz");
    assert.equal(nameOf("darwin-x86_64"), "mojuan_1.4.0_x64.app.tar.gz");
});

test("每个平台的签名就是它指向的那个制品的 .sig 文件内容", () => {
    const out = buildManifest(manifest, release, ORIGIN);
    for (const [platform, entry] of Object.entries(out.platforms)) {
        const sig = fixture(`${assetName(entry.url)}.sig`).toString("utf8");
        assert.equal(entry.signature, sig, platform);
    }
});

test("清单指向该版本没有的制品时抛出错误", () => {
    const broken = {
        ...manifest,
        platforms: { ...manifest.platforms, "windows-x86_64": { signature: "x", url: "https://api.github.com/repos/fw6/mojuan/releases/assets/1" } },
    };
    assert.throws(() => buildManifest(broken, release, ORIGIN), /windows-x86_64/);
});

test("制品地址认 API 资产地址与 Releases 直链两种形态", () => {
    assert.deepEqual(assetRefFromUrl(`https://api.github.com/repos/${REPO}/releases/assets/601292128`), {
        id: "601292128",
    });
    assert.deepEqual(
        assetRefFromUrl(`https://github.com/${REPO}/releases/download/app-v1.4.0/mojuan_1.4.0_x64-setup.exe`),
        { name: "mojuan_1.4.0_x64-setup.exe" },
    );
    assert.equal(assetRefFromUrl(undefined), null);
    assert.equal(assetRefFromUrl("https://example.com/whatever"), null);
});

test("有已发布版本时返回改写后的清单", async () => {
    const res = await callWorker("/latest.json", {
        routes: {
            [LATEST_URL]: jsonRoute(release),
            [MANIFEST_URL]: manifestRoute,
        },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.version, manifest.version);
    assert.ok(
        body.platforms["windows-x86_64"],
        "清单里没有平台条目——多半是取资产时 Accept 不对，GitHub 回了资产元数据",
    );
    assert.ok(body.platforms["windows-x86_64"].url.startsWith(`${ORIGIN}/dl/app-v1.4.0/`));
    assert.equal(Object.keys(body.platforms).length, Object.keys(manifest.platforms).length);
});

test("没有已发布版本时回 204", async () => {
    const res = await callWorker("/latest.json", {
        routes: {
            [LATEST_URL]: () => new Response("Not Found", { status: 404 }),
            [REPO_URL]: jsonRoute({ full_name: REPO }),
        },
    });
    assert.equal(res.status, 204);
});

test("token 看不到仓库时回 500，不伪装成没有更新", async () => {
    const res = await callWorker("/latest.json", {
        routes: {
            [LATEST_URL]: () => new Response("Not Found", { status: 404 }),
            [REPO_URL]: () => new Response("Not Found", { status: 404 }),
        },
    });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /GITHUB_TOKEN/);
});
test("GitHub 拒绝凭据时把它的说明带出来", async () => {
    const res = await callWorker("/latest.json", {
        routes: {
            [LATEST_URL]: () =>
                new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
        },
    });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /401.*Bad credentials/);
});

test("已发布版本里没有清单时回 204", async () => {
    const noManifest = { ...release, assets: release.assets.filter((a) => a.name !== "latest.json") };
    const res = await callWorker("/latest.json", {
        routes: { [`https://api.github.com/repos/${REPO}/releases/latest`]: jsonRoute(noManifest) },
    });
    assert.equal(res.status, 204);
});

// ---------- Android OTA 出口 ----------

test("Android 清单只改写 APK 地址，版本与 sha256 原样透传", async () => {
    const res = await callWorker("/android.json", {
        routes: {
            [LATEST_URL]: jsonRoute(releaseWithAndroid),
            [ANDROID_MANIFEST_URL]: androidManifestRoute,
        },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.version, android.version);
    assert.equal(body.sha256, android.sha256);
    assert.equal(body.url, `${ORIGIN}/dl/app-v1.4.0/mojuan-1.4.0-android.apk`);
});

test("Android 清单里的地址能直接取到该版本的 APK", async () => {
    const out = buildAndroidManifest(android, releaseWithAndroid, ORIGIN);
    const res = await callWorker(new URL(out.url).pathname, {
        routes: {
            [`https://api.github.com/repos/${REPO}/releases/tags/app-v1.4.0`]: jsonRoute(release),
            [ANDROID_APK_URL]: () =>
                new Response("apk-bytes", {
                    status: 200,
                    headers: { "content-type": "application/octet-stream", "content-length": "9" },
                }),
        },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "apk-bytes");
});

test("Android 清单指向该版本没有的制品时抛出错误", () => {
    const broken = { ...android, url: "mojuan-1.4.0-android-debug.apk" };
    assert.throws(() => buildAndroidManifest(broken, releaseWithAndroid, ORIGIN), /android/);
});

test("版本里没有 Android 清单时回 204", async () => {
    const res = await callWorker("/android.json", {
        routes: { [LATEST_URL]: jsonRoute(release) },
    });
    assert.equal(res.status, 204);
});

test("没有已发布版本时 Android 出口也回 204", async () => {
    const res = await callWorker("/android.json", {
        routes: {
            [LATEST_URL]: () => new Response("Not Found", { status: 404 }),
            [REPO_URL]: jsonRoute({ full_name: REPO }),
        },
    });
    assert.equal(res.status, 204);
});

test("桌面清单不含 Android 条目，两条通道互不影响", async () => {
    const res = await callWorker("/latest.json", {
        routes: {
            [LATEST_URL]: jsonRoute(releaseWithAndroid),
            [MANIFEST_URL]: manifestRoute,
        },
    });
    const body = await res.json();
    assert.equal(Object.keys(body.platforms).length, Object.keys(manifest.platforms).length);
    assert.ok(!("android" in body.platforms));
});

test("下载代理把上游响应体与 Range 转交出去", async () => {
    let seen = null;
    const res = await callWorker("/dl/app-v1.4.0/mojuan_1.4.0_x64-setup.exe", {
        headers: { Range: "bytes=0-9" },
        routes: {
            [`https://api.github.com/repos/${REPO}/releases/tags/app-v1.4.0`]: jsonRoute(release),
            "https://api.github.com/repos/fw6/mojuan/releases/assets/601292218": (init) => {
                seen = init;
                return new Response("0123456789", {
                    status: 206,
                    headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-9/4585005" },
                });
            },
        },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 0-9/4585005");
    assert.equal(await res.text(), "0123456789");
    assert.equal(seen.headers.Range, "bytes=0-9");
    assert.equal(seen.headers.Authorization, "Bearer token");
    assert.equal(seen.headers.Accept, "application/octet-stream");
});

test("下载代理只放行该版本里真实存在的制品", async () => {
    const res = await callWorker("/dl/app-v1.4.0/../secret", {
        routes: { [`https://api.github.com/repos/${REPO}/releases/tags/app-v1.4.0`]: jsonRoute(release) },
    });
    assert.equal(res.status, 404);
});

test("tauri.conf.json 里的 pubkey 就是给这些制品签名的那个密钥", () => {
    const conf = JSON.parse(
        readFileSync(new URL("../../mojuan/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    );
    // pubkey 与 .sig 都是「minisign 文本的 base64」，key id 在第二层二进制的第 2..10 字节
    const decode = (base64) =>
        Buffer.from(Buffer.from(base64, "base64").toString("utf8").split("\n")[1], "base64");
    const pubBlob = decode(conf.plugins.updater.pubkey);
    assert.equal(pubBlob.subarray(0, 2).toString(), "Ed");

    const keyId = pubBlob.subarray(2, 10).toString("hex");
    const sigs = release.assets.map((a) => a.name).filter((n) => n.endsWith(".sig"));
    assert.ok(sigs.length >= 6);
    for (const name of sigs) {
        assert.equal(decode(fixture(name).toString("utf8")).subarray(2, 10).toString("hex"), keyId, name);
    }
});

test("路径、方法与配置的边界", async () => {
    const root = await callWorker("/");
    assert.equal(root.status, 200);

    const unknown = await callWorker("/whatever");
    assert.equal(unknown.status, 404);

    // 未知路径不该因为缺 secret 而变成配置错误
    const unknownNoToken = await callWorker("/whatever", { env: { GITHUB_REPO: REPO } });
    assert.equal(unknownNoToken.status, 404);

    const post = await callWorker("/latest.json", { method: "POST" });
    assert.equal(post.status, 405);

    const noToken = await callWorker("/latest.json", { env: { GITHUB_REPO: REPO } });
    assert.equal(noToken.status, 500);
    assert.match(await noToken.text(), /GITHUB_TOKEN/);
});

test("schema.json 直接给出源文档的 JSON Schema，不需要凭据", async () => {
    // env 里故意不给 GITHUB_TOKEN：这个出口与更新通道无关
    const res = await callWorker("/schema.json", { env: {} });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const schema = await res.json();
    assert.equal(schema.title, "SourceDoc");
    // 客户端与源仓库靠它校验文档：顶层字段、op 的字段、取值规则的两种写法都要在里面
    for (const key of ["$schema", "schema", "id", "title", "ops", "renderChannel", "hotlinkReferers"]) {
        assert.ok(schema.properties[key], `Schema 顶层应有 ${key}`);
    }
    const opSpec = schema.definitions.OpSpec;
    for (const key of ["request", "items", "fields", "comic", "chapters", "hidden", "script"]) {
        assert.ok(opSpec.properties[key], `OpSpec 应有 ${key}`);
    }
    assert.ok(schema.definitions.Extractor.anyOf, "取值规则应是 anyOf（简写与完整写法）");
    // 仓库里那份 schema.json 必须与出口给出的一致
    const committed = JSON.parse(
        readFileSync(new URL("../src/schema.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(schema, committed);
});

test("上游出错时不吞掉，回 502", async () => {
    const res = await callWorker("/latest.json", {
        routes: {
            [`https://api.github.com/repos/${REPO}/releases/latest`]: () => new Response("boom", { status: 500 }),
        },
    });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /GitHub 500/);
});
