#!/usr/bin/env bash
# Android 目标的 cargo check。宿主 `cargo check` 看不到 #[cfg(mobile)] 的代码
#（src-tauri/src/ota.rs、各插件的 mobile.rs），改动这些之后跑一次。
#
# NDK 注入与 release.yml 的 build-android 作业同源：rquickjs-sys 的 bindgen 需要
# sysroot，ring/cc 需要 NDK 的 clang 在 PATH 上（宿主上直接 cargo check 会报
# 「failed to find tool aarch64-linux-android-clang」）。
#
# 用法：scripts/check-android.sh [cargo check 的额外参数，如 -p mojuan]
set -euo pipefail

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -n "${ANDROID_NDK_HOME:-}" ]; then
    NDK="$ANDROID_NDK_HOME"
else
    NDK="$(ls -d "$SDK"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
fi
test -n "$NDK" && test -d "$NDK" || {
    echo "找不到 Android NDK（ANDROID_HOME=$SDK）" >&2
    exit 1
}

HOST_TAG="$(ls "$NDK/toolchains/llvm/prebuilt" | head -1)"
BIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"
SYSROOT="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/sysroot"
# API 24 = app 的 minSdk（gen/android/app/build.gradle.kts）
CLANG="$BIN/aarch64-linux-android24-clang"
test -x "$CLANG" || {
    echo "找不到 $CLANG" >&2
    exit 1
}

export PATH="$BIN:$PATH"
export CC_aarch64_linux_android="$CLANG"
export AR_aarch64_linux_android="$BIN/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CLANG"
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$SYSROOT -I$SYSROOT/usr/include/aarch64-linux-android"

cd "$(dirname "${BASH_SOURCE[0]}")/../desktop"
exec cargo check --target aarch64-linux-android "$@"
