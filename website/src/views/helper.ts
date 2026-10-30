import { api } from "../api";
import { openModal, qs, toast, withButtonBusy } from "../dom";
import { icon } from "../icons";
import { pickSavePath } from "../platform";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export async function openHelperModal(): Promise<void> {
  const content = document.createElement("div");
  content.className = "helper-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">浏览器兜底</div>
        <h2>Tampermonkey 课程助手</h2>
        <p class="modal-sub">在课程页一键完成视频任务点，并浏览/完成内联 PDF 文档</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <ol class="helper-steps">
        <li>安装 Tampermonkey，新建脚本。</li>
        <li>粘贴下面的完整脚本并保存。</li>
        <li>打开课程学习页，右上角会出现控制面板。</li>
      </ol>
      <pre class="script-preview" id="script-preview">正在读取脚本…</pre>
    </div>
    <div class="modal-foot">
      <span class="modal-note">${icon("shield", 13)} 脚本不读取也不保存 Cookie</span>
      <button class="btn btn-ghost" data-copy>${icon("copy", 14)} 复制</button>
      <button class="btn btn-primary" data-save>${icon("save", 14)} 保存为 .user.js</button>
    </div>
  `;

  const close = openModal(content, { wide: true });
  const preview = qs<HTMLElement>("#script-preview", content);
  let script = "";

  content.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-close]")) {
      close();
      return;
    }
    if (!script) return;
    if (target.closest("[data-copy]")) {
      const copied = await copyText(script);
      toast(copied ? "脚本已复制到剪贴板" : "复制失败，请手动选择文本", copied ? "success" : "error");
      return;
    }
    const saveButton = target.closest<HTMLButtonElement>("[data-save]");
    if (saveButton) {
      await withButtonBusy(saveButton, "保存中…", async () => {
        try {
          const path = await pickSavePath(
            "hust-course-video-helper.user.js",
            "UserScript",
            ["js"],
          );
          if (!path) return;
          await api.saveTextFile(path, script);
          toast("脚本已保存", "success");
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), "error");
        }
      });
    }
  });

  try {
    script = await api.helperScript();
    preview.textContent = script;
  } catch (error) {
    preview.textContent = `读取脚本失败：${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}
