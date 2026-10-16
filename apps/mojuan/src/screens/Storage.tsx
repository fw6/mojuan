import { HardDrive } from "lucide-react";
import { PageHeader, Panel } from "../components/ui";
import { StorageOverview } from "../components/storage-overview";

/**
 * 整屏存储页：顶部是三项占用与缓存控制（与设置页的「存储」段同一份数据，共用
 * `StorageOverview`）。下面的下载管理由后续工单填上。入口在设置页的存储段；
 * 本页 `keep: 0`（离开即卸载），侧边栏不出现。
 */
export default function Storage() {
    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
            <PageHeader title="存储" sub="缓存与下载占用" />
            <Panel
                title="占用与缓存"
                desc="图片缓存、结果缓存与下载各占多少空间"
                actions={<HardDrive className="size-4 text-muted-foreground" />}
            >
                <StorageOverview />
            </Panel>
        </div>
    );
}
