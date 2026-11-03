import { useState } from "react";
import { btnCls } from "./shared";
import { LICENSE_FILES, THIRD_PARTY_NOTICES } from "./licenses-data";

/** 第三方许可入口：源码包 THIRD_PARTY_NOTICES.md 与 licenses/ 原文随包保留，
 * 在此面板内逐字呈现。项目自身许可证仍待作者决定，不在此面板授予任何许可。 */
export function LicensesButton() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("notices");
  const current =
    selected === "notices"
      ? THIRD_PARTY_NOTICES
      : (LICENSE_FILES.find((f) => f.name === selected)?.text ?? "");
  return (
    <>
      <button
        type="button"
        className={btnCls + " shrink-0 px-2 py-1 text-xs"}
        aria-label="查看第三方许可声明"
        onClick={() => setOpen(true)}
      >
        第三方许可
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="第三方许可声明"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-t-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-display text-lg font-bold">第三方许可声明</h2>
              <button
                type="button"
                className={btnCls + " ml-auto px-2 py-1 text-xs"}
                aria-label="关闭许可声明"
                onClick={() => setOpen(false)}
              >
                关闭
              </button>
            </div>
            <p className="mb-2 text-xs text-[var(--dim)]">
              本项目自身许可证仍待作者决定（UNLICENSED），未公开发布。以下为随源码包保留的第三方依赖声明与许可原文。
            </p>
            <select
              aria-label="选择要查看的许可文件"
              className="mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="notices">THIRD_PARTY_NOTICES.md（第三方软件声明）</option>
              {LICENSE_FILES.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--surface2)] p-3 text-xs leading-relaxed">
              {current}
            </pre>
          </div>
        </div>
      ) : null}
    </>
  );
}
