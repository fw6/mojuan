/** 源错误消息的首行：脚本报错常带「\n@行:列」的栈尾，界面只显示第一行。 */
export function errorFirstLine(message: string): string {
    return message.split("\n")[0];
}
