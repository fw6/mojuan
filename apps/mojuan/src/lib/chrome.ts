/** 窗口外壳类型：由 index.html 在首帧之前写在 html[data-chrome] 上（那里的注释说明了原因）。
 *  macos / windows 表示窗口背景交给了系统材质，界面里该让位的地方按这个标记让位。 */
export type WindowChrome = "macos" | "windows" | "none";

export function windowChrome(): WindowChrome {
    const value = document.documentElement.dataset.chrome;
    return value === "macos" || value === "windows" ? value : "none";
}
