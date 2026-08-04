// 渲染进程：读取 preload 暴露的 hnflow API，展示版本信息。
// 纯静态 JS，不参与 TypeScript 编译。

(function () {
  "use strict";

  const info = window.hnflow || { version: "unknown", platform: "unknown" };

  const versionEl = document.getElementById("version");
  if (versionEl) {
    versionEl.textContent = "v" + info.version + " · " + info.platform;
  }

  // 占位交互：后续版本接入真实工作流列表
  const newWorkflowButtons = [
    document.getElementById("new-workflow"),
    document.getElementById("create-empty")
  ];
  for (const btn of newWorkflowButtons) {
    if (btn) {
      btn.addEventListener("click", function () {
        // TODO(v0.2): 创建真实工作流
        window.alert("新建工作流（占位）");
      });
    }
  }

  const openFileBtn = document.getElementById("open-file");
  if (openFileBtn) {
    openFileBtn.addEventListener("click", function () {
      // TODO(v0.2): 打开工作流文件
      window.alert("打开工作流（占位）");
    });
  }
})();
