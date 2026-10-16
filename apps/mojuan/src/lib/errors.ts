/** 源错误消息的首行：脚本报错常带「\n@行:列」的栈尾，界面只显示第一行。 */
export function errorFirstLine(message: string): string {
    return message.split("\n")[0];
}

/** 命令失败时的可读文案（Tauri 的 Err 是字符串，JS 侧异常是 Error）。 */
export function errorText(e: unknown): string {
    if (typeof e === "string" && e) return e;
    if (e instanceof Error && e.message) return e.message;
    return "未知错误";
}
