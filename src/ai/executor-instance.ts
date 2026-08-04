// 统一 AI 执行器实例：ai/llm 节点共用同一 LangGraphExecutor（AC5 统一运行时）。
// 单例而非各自 new：保证执行器内部状态（checkpoint 连接、langchain 缓存）跨节点一致；
// 中断恢复（T5 引擎层 resume）也复用此实例。
import { LangGraphExecutor } from "./langgraph-executor.js";

/** 全局共享的 AI 执行器实例。 */
export const aiExecutor = new LangGraphExecutor();
