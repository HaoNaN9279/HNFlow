# HNFlow

**HNFlow** 是图驱动的确定性 AI 工作流编排引擎。它以 DeerFlow harness
（LangGraph super agent 底座）为内核，在其上叠加「工作流定义/编译层」：
`WorkflowDefinition` 是纯 JSON（可序列化），经 compiler 编译为 LangGraph
`StateGraph`（可执行）。断点续跑、人工挂起、取消、SSE 节点级事件全部复用
LangGraph 原生 run 生命周期，不新写执行循环。

工作流画布（React Flow 可视化编辑）与 AI 对话（lead agent 自然语言驱动）
是双入口，控制同一运行生命周期，行为一致。

---

## 仓库

本项目为 **HNFlow 改造分支**：以开源 DeerFlow 为基础，新增工作流子系统并重命名产品。代码包仍为 `deerflow.*`，契约不变。本地部署请参考仓库根目录的 `README.md` 与 `Install.md`。

---

## License

HNFlow 基于 **MIT License** 开源，继承自上游 DeerFlow。

---

## Acknowledgments

基于上游开源项目构建，向 DeerFlow 及其作者、LangChain、LangGraph 等开源社区致谢。
